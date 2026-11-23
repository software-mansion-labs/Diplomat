#!/usr/bin/env node
// A stand-in for the docker CLI, for tests that must not need an engine. It keeps its
// world under FAKE_DOCKER_DIR and implements exactly the subcommands src/executor calls.
// A "container" is a directory: its volume is <root>/work, its bind mounts are links,
// and what is exec'd in it runs on this host with DN_ROOT=<root>, with the container's
// paths in the arguments translated and with shims for the tools only a container has
// (flock, update-ca-certificates). What is named there by its full path is the image's
// own, and <root> holds the two that are: /bin/sh, dash where the host has one, and
// /usr/bin/setsid. What is put in a session of its own there is what `restart` and `rm`
// kill.
// FAKE_DOCKER_PATH is put in front of PATH for what is exec'd, which is where a test
// keeps its own `claude`. A network is a record that a container must name to be made
// and that cannot be removed from under one; nothing is isolated, and the command a
// container was made with (a relay's) is recorded and not run. A `run --rm` is the
// probe container.js measures and clears with: its `du` and its `find -delete` are done
// here, on the directories its mounts name, and answered the way GNU's are. One put in a
// container's pid namespace is the probe that counts what that container's processes
// hold open: it prints `held 0`.
//
// Staged failures, as files in FAKE_DOCKER_DIR:
//   down             the engine does not answer
//   fail-<command>   that subcommand fails once per line in the file, printing the line
//   hold-<command>   that subcommand does not go on while this file exists
//   fail-<command>-<argument>, hold-<command>-<argument>
//                    the same, of the calls with that argument among theirs
//   old-engine       a network gets a gateway address whatever it was asked for
//   no-isolated-gateway  a network asked for with the isolated gateway mode is refused
//   engine-version   the version the engine says it is, in place of a current one
//   no-storage-opt   a container asked for with a size for its writable layer is refused
//   held-<container> what a probe in that container's pid namespace prints, in place of
//                    `held 0`; empty, the probe is killed before it prints
// calls.jsonl records every invocation's arguments.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DIR = process.env.FAKE_DOCKER_DIR;
if (!DIR) { console.error('fake-docker: FAKE_DOCKER_DIR is not set'); process.exit(2); }
const argv = process.argv.slice(2);
for (const d of ['containers', 'volumes', 'images', 'roots', 'networks', 'pids']) fs.mkdirSync(path.join(DIR, d), { recursive: true });
fs.appendFileSync(path.join(DIR, 'calls.jsonl'), `${JSON.stringify(argv)}\n`);

const die = (msg, code = 1) => { process.stderr.write(`${msg}\n`); process.exit(code); };
const file = (...p) => path.join(DIR, ...p);
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const container = (name) => readJson(file('containers', `${name}.json`));
// Whole or not at all: one job's liveness probe reads this record while another job's
// start rewrites it, and a record caught half-written reads as "No such container".
const save = (c) => {
  fs.writeFileSync(file(`saving-${process.pid}`), JSON.stringify(c));
  fs.renameSync(file(`saving-${process.pid}`), file('containers', `${c.name}.json`));
};

// Options this fake understands, by how many values each takes; everything else that
// starts with a dash is a flag.
function parse(args, valued) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (rest.length === 0 && a.startsWith('-')) {
      const [flag, inline] = a.split(/=(.*)/s);
      if (valued.includes(flag)) (opts[flag] ??= []).push(inline ?? args[++i]);
      else opts[flag] = [inline ?? true];
    } else rest.push(a);
  }
  return { opts, rest };
}

function staged(command, args) {
  if (fs.existsSync(file('down'))) die('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?');
  const names = [command, ...args.filter((arg) => /^[\w-]+$/.test(arg)).map((arg) => `${command}-${arg}`)];
  while (names.some((name) => fs.existsSync(file(`hold-${name}`)))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  const f = names.map((name) => file(`fail-${name}`)).find((name) => fs.existsSync(name));
  if (!f) return;
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
  if (lines.length <= 1) fs.unlinkSync(f); else fs.writeFileSync(f, `${lines.slice(1).join('\n')}\n`);
  die(lines[0] || `${command} failed`);
}

// What `du -sxB1` and `du -sx --inodes` say of a directory: the bytes its entries hold on
// disk and how many entries there are, itself included, with no link followed.
function measure(dir) {
  let bytes = 0;
  let inodes = 0;
  const walk = (p) => {
    let st;
    try { st = fs.lstatSync(p); } catch { return; }
    bytes += st.blocks * 512;
    inodes += 1;
    if (st.isDirectory()) for (const n of fs.readdirSync(p)) walk(path.join(p, n));
  };
  walk(dir);
  return { bytes, inodes };
}

const labelsOf = (opts) => Object.fromEntries((opts['--label'] || []).map((l) => l.split(/=(.*)/s).slice(0, 2)));

// The process groups the setsid shim started in a container, one to a line.
const pidsOf = (name) => path.join(DIR, 'pids', name);

function killAll(c) {
  let pids = [];
  try { pids = fs.readFileSync(pidsOf(c.name), 'utf8').split('\n').filter(Boolean).map(Number); } catch {}
  for (const pid of pids) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
  fs.rmSync(pidsOf(c.name), { force: true });
}

const [command, ...args] = argv;
staged(command === 'container' || command === 'image' || command === 'volume' || command === 'network' ? `${command}-${args[0]}` : command, args);

switch (command) {
  case 'version':
    console.log(fs.existsSync(file('engine-version')) ? fs.readFileSync(file('engine-version'), 'utf8').trim() : '27.5.1');
    break;

  case 'network': {
    const { opts, rest } = parse(args.slice(1), ['--label', '--format', '--filter', '-o', '--subnet']);
    const [name] = rest;
    const known = () => readJson(file('networks', `${name}.json`));
    if (args[0] === 'ls') {
      const want = (opts['--filter'] || []).map((f) => f.replace(/^label=/, '').split(/=(.*)/s));
      for (const f of fs.readdirSync(file('networks'))) {
        const n = readJson(file('networks', f));
        if (n && want.every(([k, v]) => n.labels[k] === v)) console.log(n.name);
      }
    } else if (args[0] === 'inspect' && name === 'bridge') console.log('172.17.0.1 ');
    else if (args[0] === 'inspect') {
      const n = known();
      if (!n) die(`Error response from daemon: network ${name} not found`);
      console.log(JSON.stringify({ Name: n.name, Internal: n.internal, Labels: n.labels, IPAM: { Config: [{ Subnet: n.subnet, Gateway: n.gateway }] } }));
    } else if (args[0] === 'create') {
      if (known()) die(`Error response from daemon: network with name ${name} already exists`);
      if (fs.existsSync(file('no-isolated-gateway')) && (opts['-o'] || []).some((o) => o.endsWith('=isolated'))) {
        die('Error response from daemon: invalid gateway mode "isolated" for com.docker.network.bridge.gateway_mode_ipv4');
      }
      const nth = fs.readdirSync(file('networks')).length + 1;
      // An engine that does not know the isolated gateway mode takes the option and
      // gives the network a gateway all the same.
      const isolated = (opts['-o'] || []).includes('com.docker.network.bridge.gateway_mode_ipv4=isolated') && !fs.existsSync(file('old-engine'));
      const subnet = opts['--subnet'] ? opts['--subnet'][0] : `172.30.${nth}.0/24`;
      fs.writeFileSync(file('networks', `${name}.json`), JSON.stringify({ name, args, internal: !!opts['--internal'], subnet, gateway: isolated ? undefined : subnet.replace(/\d+\/\d+$/, '1'), labels: labelsOf(opts) }));
      console.log(`fake-net-${name}`);
    } else if (args[0] === 'rm') {
      if (!known()) die(`Error response from daemon: network ${name} not found`);
      for (const f of fs.readdirSync(file('containers'))) {
        const c = readJson(file('containers', f));
        if (c && c.networks.includes(name)) die(`Error response from daemon: error while removing network: network ${name} has active endpoints (name:"${c.name}")`);
      }
      fs.unlinkSync(file('networks', `${name}.json`));
    } else if (args[0] === 'connect') {
      const c = container(rest[1]);
      if (!c) die(`Error response from daemon: No such container: ${rest[1]}`);
      c.networks.push(name);
      save(c);
    } else die(`fake-docker: no such command: network ${args[0]}`, 2);
    break;
  }

  case 'image': {
    const { opts, rest } = parse(args.slice(1), ['--format', '--filter']);
    const there = () => fs.existsSync(file('images', encodeURIComponent(rest[0])));
    if (args[0] === 'inspect') {
      if (!there()) die(`Error response from daemon: No such image: ${rest[0]}`);
      console.log('sha256:fake');
    } else if (args[0] === 'ls') {
      const want = (opts['--filter'] || []).map((f) => f.replace(/^label=/, ''));
      for (const f of fs.readdirSync(file('images')).sort()) {
        if (want.every((w) => (readJson(file('images', f)) || []).includes(w))) console.log(decodeURIComponent(f));
      }
    } else if (args[0] === 'rm') {
      if (!there()) die(`Error response from daemon: No such image: ${rest[0]}`);
      // A container of an image holds it, running or not.
      for (const f of fs.readdirSync(file('containers'))) {
        const c = readJson(file('containers', f));
        if (c && c.image === rest[0]) die(`Error response from daemon: conflict: unable to remove repository reference "${rest[0]}" (must force) - container ${c.name} is using its referenced image`);
      }
      fs.unlinkSync(file('images', encodeURIComponent(rest[0])));
    } else die(`fake-docker: no such command: image ${args[0]}`, 2);
    break;
  }

  case 'build': {
    const { opts, rest } = parse(args, ['-t', '--progress', '--label']);
    console.error('#1 [internal] load build definition from Dockerfile');
    if (!fs.existsSync(path.join(rest[0], 'Dockerfile'))) die('ERROR: failed to read dockerfile');
    console.error('#2 exporting to image');
    fs.writeFileSync(file('images', encodeURIComponent(opts['-t'][0])), JSON.stringify(opts['--label'] || []));
    break;
  }

  case 'volume': {
    const { opts, rest } = parse(args.slice(1), ['--label', '--filter', '--format']);
    if (args[0] === 'create') {
      // A volume that is there is answered with as it is: its labels stay its maker's.
      if (!fs.existsSync(file('volumes', `${rest[0]}.labels`))) {
        fs.mkdirSync(file('volumes', rest[0]), { recursive: true });
        fs.writeFileSync(file('volumes', `${rest[0]}.labels`), JSON.stringify(opts['--label'] || []));
      }
      console.log(rest[0]);
    } else if (args[0] === 'inspect') {
      const labels = readJson(file('volumes', `${rest[0]}.labels`));
      if (!labels) die(`Error response from daemon: get ${rest[0]}: no such volume`);
      console.log(JSON.stringify(labels.length === 0 ? null : Object.fromEntries(labels.map((l) => l.split(/=(.*)/s).slice(0, 2)))));
    } else if (args[0] === 'rm') {
      fs.rmSync(file('volumes', rest[0]), { recursive: true, force: true });
      fs.rmSync(file('volumes', `${rest[0]}.labels`), { force: true });
    } else if (args[0] === 'ls') {
      const want = (opts['--filter'] || []).map((f) => f.replace(/^label=/, ''));
      for (const n of fs.readdirSync(file('volumes')).filter((x) => x.endsWith('.labels'))) {
        const labels = readJson(file('volumes', n)) || [];
        if (want.every((w) => labels.includes(w))) console.log(n.replace(/\.labels$/, ''));
      }
    }
    break;
  }

  case 'create':
  case 'run': {
    const { opts, rest } = parse(args, ['--name', '--label', '--security-opt', '--pids-limit', '--memory', '--memory-swap', '--cpus', '--storage-opt', '--add-host', '-v', '--network', '--network-alias', '--user', '--pid']);
    const name = opts['--name'][0];
    const networks = opts['--network'] || ['bridge'];
    for (const n of networks) if (n !== 'bridge' && n !== 'none' && !fs.existsSync(file('networks', `${n}.json`))) die(`docker: Error response from daemon: network ${n} not found`, 125);
    if (container(name)) die(`docker: Error response from daemon: Conflict. The container name "/${name}" is already in use.`, 125);
    if (!rest[0]) die('docker: invalid reference format', 125);
    if (!fs.existsSync(file('images', encodeURIComponent(rest[0])))) die(`Unable to find image '${rest[0]}' locally`, 125);
    if (opts['--storage-opt'] && fs.existsSync(file('no-storage-opt'))) {
      die('docker: Error response from daemon: --storage-opt is supported only for overlay over xfs with \'pquota\' mount option\n\nRun \'docker run --help\' for more information', 125);
    }
    if (opts['--pid']) {
      const beside = opts['--pid'][0].replace(/^container:/, '');
      const said = fs.existsSync(file(`held-${beside}`)) ? fs.readFileSync(file(`held-${beside}`), 'utf8').trim() : 'held 0';
      if (!said) process.exit(137);
      console.log(said);
      break;
    }
    if (opts['--rm']) {
      const at = Object.fromEntries((opts['-v'] || []).map((v) => { const [src, dst] = v.split(':'); return [dst, src.startsWith('/') ? src : file('volumes', src)]; }));
      const script = rest.slice(1).join(' ');
      if (/\bdu -sxB1 /.test(script)) {
        const sizes = Object.keys(at).filter((dst) => script.includes(` ${dst}`)).map((dst) => [dst, measure(at[dst])]);
        for (const [dst, m] of sizes) console.log(`${m.bytes}\t${dst}`);
        for (const [dst, m] of sizes) console.log(`${m.inodes}\t${dst}`);
      } else if (rest[1] === 'find' && rest.includes('-delete')) {
        // The path it is given, under whichever mount holds it; itself too unless -mindepth keeps it.
        const dst = Object.keys(at).find((d) => rest[2] === d || rest[2].startsWith(`${d}/`));
        const top = at[dst] + rest[2].slice(dst.length);
        if (!rest.includes('-mindepth')) fs.rmSync(top, { recursive: true, force: true });
        else for (const n of fs.readdirSync(top)) fs.rmSync(path.join(top, n), { recursive: true, force: true });
      }
      break;
    }
    const root = file('roots', name);
    fs.rmSync(root, { recursive: true, force: true });
    for (const d of ['dn', 'bin', 'usr/bin']) fs.mkdirSync(path.join(root, d), { recursive: true });
    // The image's sh is dash, which is stricter than the bash a host may call sh.
    fs.symlinkSync(fs.existsSync('/bin/dash') ? '/bin/dash' : '/bin/sh', path.join(root, 'bin/sh'));
    // In place, as setsid(1) does for what is no group leader: the pid stays.
    fs.writeFileSync(path.join(root, 'usr/bin/setsid'), '#!/bin/sh\necho $$ >> "$FAKE_DOCKER_PIDS"\nexec perl -MPOSIX -e \'POSIX::setsid(); exec { $ARGV[0] } @ARGV\' "$@"\n', { mode: 0o755 });
    const mounts = [];
    for (const v of opts['-v'] || []) {
      const [src, dst] = v.split(':');
      const host = src.startsWith('/') ? src : file('volumes', src);
      fs.mkdirSync(host, { recursive: true });
      fs.mkdirSync(path.dirname(path.join(root, dst)), { recursive: true });
      fs.symlinkSync(host, path.join(root, dst));
      mounts.push({ src, dst, host });
    }
    save({ name, image: rest[0], args, running: command === 'run', root, mounts, networks, labels: labelsOf(opts) });
    console.log(`fake-${name}`);
    break;
  }

  case 'start': {
    const c = container(args[0]);
    if (!c) die(`Error response from daemon: No such container: ${args[0]}`);
    c.running = true;
    save(c);
    break;
  }

  case 'container': {
    const { opts, rest } = parse(args.slice(1), ['--format']);
    const c = container(rest[0]);
    if (!c) die(`Error response from daemon: No such container: ${rest[0]}`);
    // The mounts are links in the root and count for nothing, as a volume does not count in a writable layer.
    console.log(JSON.stringify({ State: { Running: c.running }, Config: { Image: c.image, Labels: c.labels }, HostConfig: { NetworkMode: c.networks[0] },
      ...(opts['--size'] ? { SizeRw: measure(c.root).bytes } : {}) }));
    break;
  }

  case 'ps': {
    const { opts } = parse(args, ['--filter', '--format']);
    const want = (opts['--filter'] || []).map((f) => f.replace(/^label=/, '').split(/=(.*)/s));
    for (const n of fs.readdirSync(file('containers'))) {
      const c = readJson(file('containers', n));
      if (c && want.every(([k, v]) => c.labels[k] === v)) console.log(c.name);
    }
    break;
  }

  case 'restart': {
    const { rest } = parse(args, ['-t']);
    const c = container(rest[0]);
    if (!c) die(`Error response from daemon: No such container: ${rest[0]}`);
    killAll(c);
    c.running = true;
    save(c);
    break;
  }

  case 'rm': {
    const { rest } = parse(args, []);
    const c = container(rest[0]);
    if (!c) break;
    killAll(c);
    fs.rmSync(file('containers', `${c.name}.json`), { force: true });
    fs.rmSync(c.root, { recursive: true, force: true });
    break;
  }

  case 'exec': {
    const { opts, rest } = parse(args, ['-e']);
    const [name, ...cmd] = rest;
    const c = container(name);
    if (!c) die(`Error response from daemon: No such container: ${name}`);
    if (!c.running) die(`Error response from daemon: container ${name} is not running`);
    const shims = path.join(c.root, 'shims');
    if (!fs.existsSync(shims)) {
      // Made aside and moved in whole: two execs at once both find every shim.
      const made = `${shims}.${process.pid}`;
      fs.mkdirSync(made, { recursive: true });
      const shim = (n, body) => fs.writeFileSync(path.join(made, n), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      // A lock on the caller's open file, as flock(1) takes it: two jobs starting at once
      // install the broker's certificate one after the other, as in the image.
      if (spawnSync('sh', ['-c', 'command -v flock']).status !== 0) {
        shim('flock', `exec perl -e 'use Fcntl qw(:flock); open(my $f, ">&=", $ARGV[0]) or exit 1; flock($f, LOCK_EX) or exit 1' "$@"`);
      }
      shim('update-ca-certificates', [
        'for b in /etc/ssl/cert.pem /etc/ssl/certs/ca-certificates.crt; do [ -f "$b" ] && break; done',
        'mkdir -p "$DN_ROOT/etc/ssl/certs"',
        'cat "$b" "$DN_ROOT"/usr/local/share/ca-certificates/*.crt > "$DN_ROOT/etc/ssl/certs/ca-certificates.crt"',
      ].join('\n'));
      try { fs.renameSync(made, shims); } catch { fs.rmSync(made, { recursive: true, force: true }); }
    }
    const inside = (a) => {
      const m = c.mounts.find((x) => a === x.dst || a.startsWith(`${x.dst}/`));
      return m ? m.host + a.slice(m.dst.length) : a;
    };
    const env = {
      ...process.env,
      ...Object.fromEntries((opts['-e'] || []).map((kv) => kv.split(/=(.*)/s).slice(0, 2))),
      DN_ROOT: c.root,
      FAKE_DOCKER_PIDS: pidsOf(name),
      PATH: [process.env.FAKE_DOCKER_PATH, shims, process.env.PATH].filter(Boolean).join(':'),
    };
    const translated = cmd.map(inside);
    const own = path.join(c.root, translated[0]);
    const r = spawnSync(path.isAbsolute(translated[0]) && fs.existsSync(own) ? own : translated[0], translated.slice(1), { env, cwd: c.root, stdio: 'inherit' });
    process.exit(r.status ?? 137);
    break;
  }

  default:
    die(`fake-docker: no such command: ${command}`, 2);
}
