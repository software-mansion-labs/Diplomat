// The push check for git smart HTTP (PROTOCOL.md section 10). A push is one opaque POST,
// ref commands then a pack, so a rule on its URL says nothing about which branch moves or
// how: every command must name a ref the rule covers, delete nothing, and be a creation
// the rule permits or a fast-forward.
//
// A fast-forward is proven, not taken from the executor: the pack is indexed into a
// quarantine repository borrowing the linked checkout's objects read-only, and git is
// asked whether the old value is an ancestor of the new. The old value must be what the
// forge says the branch holds now (for a creation, a name it has no branch of), and the
// forge rejects a push whose old id is stale, so no history is rewritten and no existing
// branch taken over. The default branch and protected branches are never pushed. The
// pack is measured before git reads it: a few kilobytes can unfold to any size. Commits
// at the pack's boundary that a stale checkout lacks are fetched by id.
//
// Under a rule with `fork` the push may go to the task account's own fork instead (the
// forge says whose a repository is and what it forks); the same checks hold against the
// fork's default branch and protection.
//
// `denyPaths` keeps a push from writing CI definitions: in each pushed commit no branch of
// the forge holds, a path under it (in any case) may only hold what one of the parents
// holds there, which lets a merge bring the base branch's along. Those parents must be
// reachable from a branch of the repository pushed to (for a fork, of the pool's too),
// not merely fetchable by id: a forge that shares objects between forks hands out
// commits no branch of this repository holds.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { GIT_BIN, GIT_TIMEOUT_MS, PUSH_MAX_BYTES, PUSH_UNPACKED_MAX_BYTES } from '../paths.js';

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

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// One pkt-line of `body` at `at`: four hex digits of length, counting themselves; "0000"
// is a flush. Returns `{ payload, next }`, `payload` null for a flush.
function pktAt(body, at) {
  const head = body.subarray(at, at + 4).toString('latin1');
  if (!/^[0-9a-f]{4}$/.test(head)) throw new SyntaxError('a malformed pkt-line length');
  const len = parseInt(head, 16);
  if (len === 0) return { payload: null, next: at + 4 };
  if (len <= 4 || at + len > body.length) throw new SyntaxError('a pkt-line of impossible length');
  return { payload: body.subarray(at + 4, at + len), next: at + len };
}

/// Reads the head of a git-receive-pack request body: the ref commands, the capabilities
/// and any push options, up to the pack. Returns `{ commands: [{ old, new, ref }], caps,
/// options, format, pack }` (`pack` is the rest of the body, `format` is "sha1" or
/// "sha256") or throws for a body that is not exactly that.
export function parseReceivePack(body) {
  let at = 0;
  const pkt = () => {
    const { payload, next } = pktAt(body, at);
    at = next;
    return payload;
  };
  // Bytes that are not UTF-8 would be read here as one name and by the forge as another.
  const text = (payload) => {
    try { return utf8.decode(payload).replace(/\n$/, ''); } catch { throw new SyntaxError('a line that is not UTF-8'); }
  };
  const commands = [];
  let caps = [];
  for (;;) {
    const payload = pkt();
    if (payload === null) break;
    let line = text(payload);
    // A shallow line makes the forge's repository shallow: no task has a use for one.
    if (line.startsWith('shallow ')) throw new SyntaxError('a shallow line');
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
      options.push(text(payload));
    }
  }
  const pack = body.subarray(at);
  if (pack.length > 0 && (pack.length < 12 || pack.subarray(0, 4).toString('latin1') !== 'PACK' || ![2, 3].includes(pack.readUInt32BE(4)))) {
    throw new SyntaxError('what follows the commands is not a pack');
  }
  return { commands, caps, options, format, pack };
}

/// The forge's report on a push: `{ ok, ng }`, the refs it updated and declined, as
/// pkt-lines or inside side-band 1. Null for an answer this cannot follow to its end.
export function pushReport(body) {
  try {
    let lines = [];
    for (let at = 0; at < body.length;) {
      const { payload, next } = pktAt(body, at);
      at = next;
      if (payload !== null) lines.push(payload);
    }
    if (lines.length > 0 && lines.every((l) => l[0] >= 1 && l[0] <= 3)) {
      const inner = Buffer.concat(lines.filter((l) => l[0] === 1).map((l) => l.subarray(1)));
      lines = [];
      for (let at = 0; at < inner.length;) {
        const { payload, next } = pktAt(inner, at);
        at = next;
        if (payload === null) break;
        lines.push(payload);
      }
    }
    const report = lines.map((l) => utf8.decode(l).replace(/\n$/, ''));
    if (!/^unpack /.test(report[0] ?? '')) return null;
    const ok = [];
    const ng = [];
    for (const line of report.slice(1)) {
      if (line.startsWith('ok ')) ok.push(line.slice(3));
      else if (line.startsWith('ng ')) ng.push(line.slice(3).split(' ')[0]);
      else if (!line.startsWith('option ')) return null;
    }
    // A ref said both ways, or an "ok" beside a failed unpack, is no report to act on.
    if (ok.some((ref) => ng.includes(ref)) || (report[0] !== 'unpack ok' && ok.length > 0)) return null;
    return { ok, ng };
  } catch {
    return null;
  }
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

// Whose a repository is and what it forks are the forge's word, never the path's. Every
// other case gets one refusal, a nonexistent name included, so it does not tell which
// repositories the account has.
async function ownFork(asked, owner, repo, ctx) {
  if (typeof ctx.repository !== 'function') refuse('nothing here can ask the forge about its branches');
  // A name spelled with an escape is not asked about: the forge would read another one.
  const there = /^[a-z0-9._/-]+$/i.test(asked) ? await ctx.repository(asked) : null;
  if (!there || lower(there.owner) !== lower(owner) || lower(there.parent) !== lower(repo)) refuse(`${asked} is not this account's own fork of the pool's repository`);
  return there;
}

/// Whether `asked` (a repository's path, or on GitLab a project's number) is the fork of
/// `repo` that the account `owner` holds itself: `{ ok: true, fork }` with what
/// `ctx.repository` says of it, or `{ ok: false, reason }`.
export function checkFork(asked, owner, repo, ctx = {}) {
  return verdict(async () => ({ ok: true, fork: await ownFork(asked, owner, repo, ctx) }));
}

// Where a push goes (the pool's repository, or the account's `fork`) and, for a rule
// scoped to PRs (`head`), the head branches that live there, as the forge reports them
// now. `refs` null means "any": only the advertisement asks, before a ref is named.
async function destination(rule, segments, ctx, refs) {
  const asked = repoOf(segments);
  if (rule.fork === undefined && asked !== lower(rule.repo)) refuse('this is not the pool\'s repository');
  const fork = rule.fork === undefined ? undefined : await ownFork(asked, rule.fork, rule.repo, ctx);
  if (!rule.head) return { fork, heads: [] };
  const scope = rule.head;
  // A fork is told by the forge's id of it: a merge request names its source project no other way.
  const mine = (pull) => pull.open === true && (fork ? pull.headRepoId === fork.id : lower(pull.headRepo) === lower(rule.repo))
    && (scope.author === undefined || lower(pull.author) === scope.author);
  if (scope.number !== undefined) {
    if (typeof ctx.pull !== 'function') refuse('nothing here can look a pull request up');
    const pull = await ctx.pull(scope.number);
    if (!pull || !mine(pull)) refuse(`this repository does not hold the head branch of open pull request #${scope.number}`);
    return { fork, heads: [`refs/heads/${pull.headRef}`] };
  }
  if (typeof ctx.pullsByHead !== 'function') refuse('nothing here can look a pull request up');
  const heads = [];
  for (const ref of refs || [null]) {
    const branch = ref === null ? undefined : ref.replace(/^refs\/heads\//, '');
    for (const pull of await ctx.pullsByHead(branch, rule.fork)) if (mine(pull)) heads.push(`refs/heads/${pull.headRef}`);
  }
  if (heads.length === 0) refuse(`no open pull request by ${scope.author} has its head branch here`);
  return { fork, heads };
}

/// The check for the ref advertisement a push starts with: the repository must be the
/// pool's or its `fork`, and for a rule scoped to PRs one must have its head there.
export function checkAdvertise(rule, segments, ctx = {}) {
  return verdict(async () => {
    await destination(rule, segments, ctx, null);
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

// Adds up what a pack unfolds to once git reads it: the size of each object, and for a
// delta its own bytes and the size of the object it says it builds. git holds an object
// whole in memory to index it, and a delta of four bytes can ask for sixteen mebibytes
// more, so the bytes on the wire bound nothing.
async function unfold(pack, idLength) {
  const broken = () => refuse('the pushed pack is not one git would read');
  const end = pack.length - idLength;
  let at = 12;
  let total = 0;
  const count = (bytes) => {
    total += bytes;
    if (total > PUSH_UNPACKED_MAX_BYTES) refuse('the pushed pack unfolds to more than a task may send');
  };
  // A little-endian base-128 number, seven bits a byte, in `from` at `pos`.
  const number = (from, pos, limit, first = 0, scale = 1) => {
    let value = first;
    for (let byte = 0x80; byte & 0x80; scale *= 128) {
      if (pos >= limit || scale > 2 ** 46) broken();
      byte = from[pos++];
      value += (byte & 0x7f) * scale;
    }
    return { value, pos };
  };
  for (let i = pack.readUInt32BE(8); i > 0; i--) {
    if (at >= end) broken();
    const type = (pack[at] >> 4) & 7;
    const size = pack[at] & 0x80 ? number(pack, at + 1, end, pack[at] & 15, 16) : { value: pack[at] & 15, pos: at + 1 };
    at = size.pos;
    // A delta names its base before its data: by distance back in the pack, or by id.
    if (type === 6) {
      while (pack[at++] & 0x80) if (at >= end) broken();
    } else if (type === 7) {
      at += idLength;
    } else if (type < 1 || type > 4) {
      broken();
    }
    count(size.value);
    let data;
    try {
      const inflated = zlib.inflateSync(pack.subarray(at, end), { info: true, maxOutputLength: Math.max(size.value, 1) });
      data = inflated.buffer;
      at += inflated.engine.bytesWritten;
    } catch { broken(); }
    if (data.length !== size.value) broken();
    // A delta's data opens with two sizes: its base's, and that of the object it builds.
    if (type > 4) count(number(data, number(data, 0, data.length).pos, data.length).value);
    if (i % 4096 === 0) await new Promise((resolve) => setImmediate(resolve));
  }
  if (at !== end) broken();
}

async function prove(deny, push, ctx, fork) {
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
    const fetch = async (what) => typeof ctx.fetch === 'function' && (await ctx.fetch({ env, ...what })) === true;
    // The quarantine is filled from the repository pushed to and, for a push to a fork
    // (`fork` is its name), from the pool's as well: the base branch a fork's pull
    // request merges lives there. A repository left unnamed is the pool's.
    const sources = fork === undefined ? [undefined] : [fork, undefined];
    let everything;
    const fetchAll = () => (everything ??= (async () => {
      for (const [i, repo] of sources.entries()) if (!(await fetch({ repo, into: `refs/dn/${i}` }))) return false;
      return true;
    })());

    // Which of `oids` the quarantine cannot read as commits, after asking the forge for them.
    const missing = async (oids) => {
      const absent = async () => {
        if (oids.length === 0) return [];
        const r = await git(['cat-file', '--batch-check=%(objectname) %(objecttype)'], `${oids.join('\n')}\n`);
        const have = new Set(r.stdout.split('\n').filter((l) => l.endsWith(' commit')).map((l) => l.split(' ')[0]));
        return oids.filter((oid) => !have.has(oid));
      };
      let gone = await absent();
      for (const repo of sources) if (gone.length > 0 && (await fetch({ repo, wants: gone }))) gone = await absent();
      if (gone.length > 0 && (await fetchAll())) gone = await absent();
      return gone;
    };

    const packed = new Set();
    if (push.pack.length >= 12 && push.pack.readUInt32BE(8) > 0) {
      await unfold(push.pack, push.format === 'sha256' ? 32 : 20);
      // The proof reads the pushed trees: one git itself calls broken (an entry named
      // twice, out of order, ".git") is one two readers may read two ways.
      const index = () => git(['index-pack', '--stdin', '--fix-thin', '--fsck-objects'], push.pack);
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

    if (deny.length > 0) {
      if (!(await fetchAll())) refuse('the forge\'s branches could not be fetched, so the pushed files cannot be checked');
      const base = [...boundary, ...news.filter((oid) => !packed.has(oid))];
      if (base.length > 0) {
        const stray = await git(['rev-list', '--max-count=1', '--stdin', '--not', '--glob=refs/dn/*'], `${base.join('\n')}\n`);
        if (stray.code !== 0 || stray.stdout.trim() !== '') refuse('the push builds on a commit no branch of this repository holds');
      }
      // A commit some branch of the forge holds is not this push's to answer for: a pack
      // sent to a fork that fell behind carries the base branch's own commits along.
      const fresh = await git(['rev-list', '--stdin', '--not', '--glob=refs/dn/*'], `${commits.join('\n')}\n`);
      if (fresh.code !== 0) refuse('the pushed commits could not be told from the forge\'s own');
      // Combined format: for each commit, the files that differ from every parent, a file
      // the commit deletes among them. Listing only the directories the patterns start in
      // keeps this cheap on a big tree. Case is not told apart: a forge or a runner on a
      // file system that folds it reads ".GitHub/workflows" as the directory it knows.
      const prefixes = deny.map((p) => p.split('/').slice(0, p.split('/').findIndex((s) => s.includes('*')) >>> 0).join('/'));
      const spec = prefixes.includes('') ? [] : ['--', ...new Set(prefixes.map((p) => `:(icase,literal)${p}`))];
      const diff = await git(['diff-tree', '--stdin', '-r', '-c', '--root', '--raw', '--no-abbrev', '-z', ...spec], fresh.stdout);
      if (diff.code !== 0) refuse('the pushed commits could not be compared with their parents');
      const tokens = diff.stdout.split('\0');
      const patterns = deny.map((p) => p.toLowerCase());
      for (let i = 0; i < tokens.length; i++) {
        if (!tokens[i].startsWith(':')) continue;
        const file = tokens[++i];
        if (patterns.some((p) => globMatch(p, file.toLowerCase()))) refuse(`the push changes ${file}, which this task may not write`);
      }
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/// The name a branch goes by in a task's state: its ref for one in the pool's repository,
/// "<repository>:<ref>" for one in a fork, so the two are never taken for each other.
export const branchLabel = (ref, fork) => (fork === undefined ? ref : `${lower(fork)}:${ref}`);

/// The check for `POST .../git-receive-pack`. Resolves to `{ ok: true, created }` - each
/// branch the push would create as `{ branch, sha }` (its `branchLabel` and commit), for
/// the caller to count against `create` - or `{ ok: false, reason }`. A ref may be
/// created when `create` is positive and `refs` covers it, and updated when it is the
/// head branch `head` names or one of `ctx.state.branches` (those the forge accepted from
/// this task). A lookup that throws is the caller's to turn into a refusal.
export function checkPush(rule, segments, body, ctx = {}) {
  return verdict(async () => {
    if (body.length > PUSH_MAX_BYTES) refuse('the push is larger than a task may send');
    let push;
    try { push = parseReceivePack(body); } catch (err) { refuse(`not a well-formed push: ${err.message}`); }
    if (push.options.length > 0) refuse('push options are not allowed');
    // What a push did is known from the forge's report alone, and the forge sends one only when asked.
    if (!push.caps.includes('report-status') && !push.caps.includes('report-status-v2')) refuse('the push does not ask the forge for its report (report-status)');

    const { fork, heads } = await destination(rule, segments, ctx, push.commands.map((c) => c.ref));
    const own = ctx.state?.branches || [];
    const covered = (ref) => (rule.refs || []).some((p) => globMatch(p, ref));
    const created = [];
    for (const cmd of push.commands) {
      if (ZERO.test(cmd.new)) refuse(`${cmd.ref}: a task may not delete a ref`);
      if (ZERO.test(cmd.old)) {
        if (!(rule.create > 0) || !covered(cmd.ref)) refuse(`${cmd.ref}: this task may not create that ref`);
        created.push({ branch: branchLabel(cmd.ref, fork?.name), sha: cmd.new });
      } else if (!heads.includes(cmd.ref) && !own.includes(branchLabel(cmd.ref, fork?.name))) {
        refuse(`${cmd.ref}: this task may not update that ref`);
      }
    }
    if (push.pack.length === 0) refuse('the push carries no pack');
    if (typeof ctx.repository !== 'function' || typeof ctx.branch !== 'function' || typeof ctx.protects !== 'function') refuse('nothing here can ask the forge about its branches');
    const pool = async () => (await ctx.repository()) ?? refuse('the forge shows no repository where the pool\'s should be');
    const there = fork ?? await pool();
    for (const cmd of push.commands) {
      // A pull request's head may be the default branch, and a created name may be the one
      // an empty or renamed repository is waiting for.
      if (lower(cmd.ref) === lower(`refs/heads/${there.defaultBranch}`)) refuse(`${cmd.ref}: the default branch is never pushed by a task`);
      const now = await ctx.branch(cmd.ref, fork?.name);
      if (now?.protected) refuse(`${cmd.ref}: a protected branch is never pushed by a task`);
      // A name nothing holds yet is protected by the rules that would cover it: code pushed
      // there would run in CI with what the forge keeps for protected branches.
      if (!now && await ctx.protects(cmd.ref, fork?.name)) refuse(`${cmd.ref}: a protection rule of the forge covers that name, and a task never creates such a branch`);
      // A creation is of a name the forge says is free: creating a branch that exists
      // would be a way to claim it.
      if ((now?.sha ?? '') !== (ZERO.test(cmd.old) ? '' : cmd.old)) refuse(`${cmd.ref}: the forge's branch is not where this push starts from`);
    }
    // A merge request from a fork can have its pipeline run in the pool's project, which
    // reads the file that project is set to read.
    const ciPaths = fork ? [...fork.ciPaths, ...(await pool()).ciPaths] : there.ciPaths;
    await prove([...(rule.denyPaths || []), ...ciPaths], push, ctx, fork?.name);
    return { ok: true, created };
  });
}
