// The push check for git smart HTTP (PROTOCOL.md section 10). A push is one opaque POST:
// a list of ref commands followed by a pack. A rule on its URL says nothing about which
// branch moves or how, so the command list is read here and every command must pass:
// the ref is one the rule covers, it is not deleted, and it is either a creation the rule
// permits or a fast-forward.
//
// "Fast-forward" is proven, not taken from the executor: the pack is indexed into a
// quarantine repository that borrows the linked checkout's objects read-only, and git is
// asked whether the ref's old value is an ancestor of the new one. Whether the old value
// is really what the forge holds is the forge's own check - it rejects a push whose old id
// is not the ref's current value - so the two together leave no way to rewrite history.
//
// The pack usually stops at commits the forge already has (the pack's boundary), and a
// stale checkout may not have them. They are fetched into the quarantine by id, so git
// sees a whole graph.
//
// `denyPaths` keeps a push from writing CI definitions. Every pushed commit is compared
// with its parents: a path under `denyPaths` may only hold what one of the parents holds
// there, which lets a merge bring the base branch's workflow files along and stops a
// commit from writing its own. The commits the push builds on must then be the forge's
// own: reachable from a branch of that repository, not merely fetchable by id - a forge
// that shares objects between forks hands out commits no branch of this repository holds.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GIT_BIN, GIT_TIMEOUT_MS, PUSH_MAX_BYTES } from '../paths.js';

const MAX_COMMANDS = 64;
const ZERO = /^0+$/;

class Refusal extends Error {}
const refuse = (reason) => { throw new Refusal(reason); };
const verdict = async (fn) => {
  try { return await fn(); } catch (err) {
    if (err instanceof Refusal) return { ok: false, reason: err.message };
    throw err;
  }
};

// ---------------------------------------------------------------------- the wire

// git check-ref-format, for the names a push may carry.
function validRef(ref) {
  if (!ref.startsWith('refs/') || ref.length > 1024 || ref.endsWith('/') || ref.endsWith('.')) return false;
  if (/[\u0000-\u0020\u007f~^:?*[\\]/.test(ref) || ref.includes('..') || ref.includes('@{') || ref.includes('//')) return false;
  return ref.split('/').every((part) => part !== '' && !part.startsWith('.') && !part.endsWith('.lock'));
}

/// Reads the head of a git-receive-pack request body: the ref commands, the capabilities
/// and any push options, up to the pack. Returns `{ commands: [{ old, new, ref }], caps,
/// options, shallow, format, pack }` (`pack` is the rest of the body, `format` is "sha1" or
/// "sha256") or throws for a body that is not exactly that.
export function parseReceivePack(body) {
  let at = 0;
  // One pkt-line: four hex digits of length, counting themselves; "0000" is a flush.
  const pkt = () => {
    const head = body.subarray(at, at + 4).toString('latin1');
    if (!/^[0-9a-f]{4}$/.test(head)) throw new SyntaxError('a malformed pkt-line length');
    const len = parseInt(head, 16);
    if (len === 0) { at += 4; return null; }
    if (len <= 4 || at + len > body.length) throw new SyntaxError('a pkt-line of impossible length');
    const payload = body.subarray(at + 4, at + len);
    at += len;
    return payload;
  };
  const commands = [];
  const shallow = [];
  let caps = [];
  for (;;) {
    const payload = pkt();
    if (payload === null) break;
    let line = payload.toString('utf8').replace(/\n$/, '');
    if (commands.length === 0 && shallow.length < MAX_COMMANDS && /^shallow [0-9a-f]{40,64}$/.test(line)) { shallow.push(line.slice(8)); continue; }
    const nul = line.indexOf('\0');
    if (nul !== -1) {
      if (commands.length > 0) throw new SyntaxError('capabilities on a later command');
      caps = line.slice(nul + 1).split(' ').filter(Boolean);
      line = line.slice(0, nul);
    }
    const m = /^([0-9a-f]+) ([0-9a-f]+) (.+)$/.exec(line);
    if (!m || m[1].length !== m[2].length || (m[1].length !== 40 && m[1].length !== 64)) throw new SyntaxError('a malformed ref command');
    if (!validRef(m[3])) throw new SyntaxError('a ref name git would not accept');
    if (commands.some((c) => c.ref === m[3])) throw new SyntaxError('a ref named twice');
    if (commands.length >= MAX_COMMANDS) throw new SyntaxError('too many ref commands');
    commands.push({ old: m[1], new: m[2], ref: m[3] });
  }
  if (commands.length === 0) throw new SyntaxError('no ref command');
  if (caps.some((c) => /[\u0000-\u001f\u007f]/.test(c))) throw new SyntaxError('a malformed capability');
  const width = commands[0].old.length;
  if (commands.some((c) => c.old.length !== width)) throw new SyntaxError('object ids of two lengths');
  const declared = caps.find((c) => c.startsWith('object-format='))?.slice(14) || 'sha1';
  const format = width === 64 ? 'sha256' : 'sha1';
  if (declared !== format) throw new SyntaxError('object ids that do not fit the declared object format');
  const options = [];
  if (caps.includes('push-options')) {
    for (;;) {
      const payload = pkt();
      if (payload === null) break;
      options.push(payload.toString('utf8').replace(/\n$/, ''));
    }
  }
  const pack = body.subarray(at);
  if (pack.length > 0 && (pack.length < 12 || pack.subarray(0, 4).toString('latin1') !== 'PACK' || ![2, 3].includes(pack.readUInt32BE(4)))) {
    throw new SyntaxError('what follows the commands is not a pack');
  }
  return { commands, caps, options, shallow, format, pack };
}

/// Whether `text` matches a glob whose "*" stays inside one "/"-separated part and whose
/// "**" part spans any number of them. Used for ref names and for `denyPaths`.
export function globMatch(pattern, text) {
  const parts = pattern.split('/');
  const words = text.split('/');
  const part = (p) => new RegExp(`^${p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
  const go = (i, j) => {
    if (i === parts.length) return j === words.length;
    if (parts[i] === '**') {
      for (let k = j; k <= words.length; k++) if (go(i + 1, k)) return true;
      return false;
    }
    return j < words.length && part(parts[i]).test(words[j]) && go(i + 1, j + 1);
  };
  return go(0, 0);
}

// ------------------------------------------------------------------ which refs

// The repository a smart-HTTP path addresses: everything before /info/refs or
// /git-receive-pack, without a trailing ".git", lowercase.
function repoOf(segments) {
  const tail = segments.at(-1) === 'git-receive-pack' ? 1 : 2;
  return segments.slice(0, -tail).join('/').replace(/\.git$/i, '').toLowerCase();
}

const lower = (s) => String(s ?? '').toLowerCase();

// For a rule scoped to pull requests' head branches: the refs of `repo` this push may
// move, as the forge reports them now. `refs` null means "any" - a question only the
// advertisement asks, before a ref is named.
async function headRefs(rule, repo, ctx, refs) {
  const scope = rule.head;
  const mine = (pull) => pull && pull.open === true && lower(pull.headRepo) === repo
    && (scope.author === undefined || lower(pull.author) === scope.author);
  if (scope.number !== undefined) {
    if (typeof ctx.pull !== 'function') refuse('nothing here can look a pull request up');
    const pull = await ctx.pull(scope.number);
    if (!mine(pull)) refuse(`this repository does not hold the head branch of open pull request #${scope.number}`);
    return [`refs/heads/${pull.headRef}`];
  }
  if (typeof ctx.pullsByHead !== 'function') refuse('nothing here can look a pull request up');
  const out = [];
  for (const ref of refs || [null]) {
    const branch = ref === null ? undefined : ref.replace(/^refs\/heads\//, '');
    const pulls = (await ctx.pullsByHead({ repo, ref: branch })) || [];
    for (const pull of pulls) if (mine(pull) && (branch === undefined || pull.headRef === branch)) out.push(`refs/heads/${pull.headRef}`);
  }
  if (out.length === 0) refuse(`no open pull request by ${scope.author} has its head branch here`);
  return out;
}

/// The check for `GET .../info/refs?service=git-receive-pack`, the ref advertisement a
/// push starts with: the repository must be one the rule's push could go to.
export function checkAdvertise(rule, segments, ctx = {}) {
  return verdict(async () => {
    const repo = repoOf(segments);
    if (rule.head) await headRefs(rule, repo, ctx, null);
    else if (repo !== lower(rule.repo)) refuse('this is not the pool\'s repository');
    return { ok: true };
  });
}

// ------------------------------------------------------------------- quarantine

function run(args, { env, input, cwd }) {
  return new Promise((resolve) => {
    const child = spawn(GIT_BIN, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), GIT_TIMEOUT_MS);
    child.stdout.on('data', (b) => out.push(b));
    child.stderr.on('data', (b) => err.push(b));
    child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); resolve({ code: null, stdout: '', stderr: 'git could not be started' }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
    child.stdin.end(input ?? '');
  });
}

// Nothing of the operator's git configuration, and no prompt, reaches these commands.
const baseEnv = (home) => ({
  PATH: process.env.PATH || '/usr/bin:/bin',
  HOME: home,
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
});

async function prove(rule, repo, push, ctx) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dn-quarantine-'));
  try {
    const gitDir = path.join(dir, 'q.git');
    const env = { ...baseEnv(dir), GIT_DIR: gitDir, GIT_OBJECT_DIRECTORY: path.join(gitDir, 'objects') };
    if (ctx.checkout) {
      const common = await run(['-C', ctx.checkout, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { env: baseEnv(dir) });
      if (common.code === 0) env.GIT_ALTERNATE_OBJECT_DIRECTORIES = path.join(common.stdout.trim(), 'objects');
    }
    const formatArgs = push.format === 'sha256' ? ['--object-format=sha256'] : [];
    if ((await run(['init', '--bare', '--quiet', ...formatArgs, gitDir], { env })).code !== 0) refuse('the quarantine could not be set up');
    const git = (args, input) => run(args, { env, input });
    const fetch = async (what) => typeof ctx.fetch === 'function' && (await ctx.fetch({ repo, env, ...what })) === true;
    let everything;
    const fetchAll = () => (everything ??= fetch({ all: true }));

    // Which of `oids` the quarantine cannot read as commits, after asking the forge for them.
    const missing = async (oids) => {
      const absent = async () => {
        if (oids.length === 0) return [];
        const r = await git(['cat-file', '--batch-check=%(objectname) %(objecttype)'], `${oids.join('\n')}\n`);
        const have = new Set(r.stdout.split('\n').filter((l) => l.endsWith(' commit')).map((l) => l.split(' ')[0]));
        return oids.filter((oid) => !have.has(oid));
      };
      let gone = await absent();
      if (gone.length > 0 && ((await fetch({ wants: gone })) || (await fetchAll()))) gone = await absent();
      return gone;
    };

    const packed = new Set();
    if (push.pack.length >= 12 && push.pack.readUInt32BE(8) > 0) {
      const index = () => git(['index-pack', '--stdin', '--fix-thin', `--max-input-size=${PUSH_MAX_BYTES}`], push.pack);
      let indexed = await index();
      // A thin pack leans on objects the forge has; a stale checkout may lack them.
      if (indexed.code !== 0 && (await fetchAll())) indexed = await index();
      const name = /^(?:pack|keep)\t([0-9a-f]+)$/m.exec(indexed.stdout)?.[1];
      if (indexed.code !== 0 || !name) refuse('the pushed pack could not be indexed');
      const idx = await fs.readFile(path.join(gitDir, 'objects', 'pack', `pack-${name}.idx`));
      const listed = await git(['show-index', ...formatArgs], idx);
      if (listed.code !== 0) refuse('the pushed pack could not be listed');
      for (const line of listed.stdout.split('\n')) if (line) packed.add(line.split(' ')[1]);
    }

    const news = push.commands.map((c) => c.new);
    if ((await missing(news)).length > 0) refuse('a ref would point at something that is not a commit the push carries or the forge has');
    const olds = push.commands.filter((c) => !ZERO.test(c.old)).map((c) => c.old);
    if ((await missing(olds)).length > 0) refuse('a ref\'s old value cannot be found, so a fast-forward cannot be proven');

    // The pack's boundary: parents of pushed commits that were not pushed themselves.
    const boundary = [];
    let commits = [];
    if (packed.size > 0) {
      const kinds = await git(['cat-file', '--batch-check=%(objectname) %(objecttype)'], `${[...packed].join('\n')}\n`);
      commits = kinds.stdout.split('\n').filter((l) => l.endsWith(' commit')).map((l) => l.split(' ')[0]);
      const parents = await git(['rev-list', '--no-walk=unsorted', '--parents', '--stdin'], `${commits.join('\n')}\n`);
      if (commits.length > 0 && parents.code !== 0) refuse('the pushed commits could not be read');
      for (const line of parents.stdout.split('\n')) {
        for (const parent of line.split(' ').slice(1)) if (!packed.has(parent) && !boundary.includes(parent)) boundary.push(parent);
      }
    }
    if ((await missing(boundary)).length > 0) refuse('a pushed commit builds on one that cannot be found');

    for (const cmd of push.commands) {
      if (ZERO.test(cmd.old)) continue;
      const r = await git(['merge-base', '--is-ancestor', cmd.old, cmd.new]);
      if (r.code === 1) refuse(`${cmd.ref}: not a fast-forward - the push would discard commits the forge has`);
      if (r.code !== 0) refuse(`${cmd.ref}: a fast-forward cannot be proven`);
    }

    const deny = rule.denyPaths || [];
    if (deny.length > 0) {
      if (!(await fetchAll())) refuse('the forge\'s branches could not be fetched, so the pushed files cannot be checked');
      const base = [...boundary, ...news.filter((oid) => !packed.has(oid))];
      if (base.length > 0) {
        const stray = await git(['rev-list', '--max-count=1', '--stdin', '--not', '--glob=refs/dn/*'], `${base.join('\n')}\n`);
        if (stray.code !== 0 || stray.stdout.trim() !== '') refuse('the push builds on a commit no branch of this repository holds');
      }
      // Combined format: for each commit, the files that differ from every parent. Listing
      // only the directories the patterns start in keeps this cheap on a big tree.
      const prefixes = deny.map((p) => p.split('/').slice(0, p.split('/').findIndex((s) => s.includes('*')) >>> 0).join('/'));
      const spec = prefixes.includes('') ? [] : ['--', ...new Set(prefixes)];
      const diff = await git(['diff-tree', '--stdin', '-r', '-c', '--root', '--raw', '--no-abbrev', '-z', ...spec], `${commits.join('\n')}\n`);
      if (diff.code !== 0) refuse('the pushed commits could not be compared with their parents');
      const tokens = diff.stdout.split('\0');
      for (let i = 0; i < tokens.length; i++) {
        if (!tokens[i].startsWith(':')) continue;
        const parents = /^:+/.exec(tokens[i])[0].length;
        const file = tokens[++i];
        // The mode after the parents' is the commit's own; all zeroes is a deletion.
        if (/^0+$/.test(tokens[i - 1].split(' ')[parents])) continue;
        if (deny.some((p) => globMatch(p, file))) refuse(`the push changes ${file}, which this task may not write`);
      }
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/// The check for `POST .../git-receive-pack`. `rule` is the matched rule (`refs`, `create`,
/// `head`, `denyPaths`, `repo`), `segments` the request path's parts and `body` the
/// request body. Resolves to `{ ok: true, created }` - the branches the push would create,
/// for the caller to count against `create` - or `{ ok: false, reason }`. A ref may be
/// created when `create` is positive and `refs` covers it, and updated when it is the head
/// branch `head` names or one this key created. `ctx.checkout` is the linked checkout whose
/// objects the proof may read, `ctx.fetch({ repo, env, wants | all })` fetches from the
/// forge into the quarantine, `ctx.currentRef(repo, ref)` is the forge's value of a ref and
/// `ctx.state.branches` lists the branches this key created.
export function checkPush(rule, segments, body, ctx = {}) {
  return verdict(async () => {
    if (body.length > PUSH_MAX_BYTES) refuse('the push is larger than a task may send');
    const repo = repoOf(segments);
    if (!rule.head && repo !== lower(rule.repo)) refuse('this is not the pool\'s repository');
    let push;
    try { push = parseReceivePack(body); } catch (err) { refuse(`not a well-formed push: ${err.message}`); }
    if (push.options.length > 0) refuse('push options are not allowed');

    const heads = rule.head ? await headRefs(rule, repo, ctx, push.commands.map((c) => c.ref)) : [];
    const own = ctx.state?.branches || [];
    const covered = (ref) => (rule.refs || []).some((p) => globMatch(p, ref));
    const created = [];
    for (const cmd of push.commands) {
      if (ZERO.test(cmd.new)) refuse(`${cmd.ref}: a task may not delete a ref`);
      if (ZERO.test(cmd.old)) {
        if (!(rule.create > 0) || !covered(cmd.ref)) refuse(`${cmd.ref}: this task may not create that ref`);
        created.push(cmd.ref);
      } else if (!heads.includes(cmd.ref) && !own.includes(cmd.ref)) {
        refuse(`${cmd.ref}: this task may not update that ref`);
      }
    }
    if (push.pack.length === 0) refuse('the push carries no pack');
    // A created branch becomes the key's own, which it may then move. The forge must say
    // the name is free first, or creating a branch that exists would be a way to claim it.
    if (typeof ctx.currentRef !== 'function') refuse('nothing here can ask the forge where a branch is');
    for (const cmd of push.commands) {
      const now = (await ctx.currentRef(repo, cmd.ref)) ?? '';
      if (now !== (ZERO.test(cmd.old) ? '' : cmd.old)) refuse(`${cmd.ref}: the forge's branch is not where this push starts from`);
    }
    await prove(rule, repo, push, ctx);
    return { ok: true, created };
  });
}
