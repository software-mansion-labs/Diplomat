#!/usr/bin/env node
// A stand-in for the docker CLI, for tests that must not need an engine. It keeps its
// world under FAKE_DOCKER_DIR and implements exactly the subcommands src/executor calls.
// A "container" is a directory: its volume is <root>/work, its bind mounts are links,
// and what is exec'd in it runs on this host with DN_ROOT=<root>, with the container's
// paths in the arguments translated and with shims for the tools only a container has
// (setsid, flock, update-ca-certificates, and dash as sh where the host has one). FAKE_DOCKER_PATH is put in front of PATH for
// what is exec'd, which is where a test keeps its own `claude`.
//
// Staged failures, as files in FAKE_DOCKER_DIR:
//   down             the engine does not answer
//   fail-<command>   that subcommand fails once per line in the file, printing the line
//   build-ms         a build takes this long
// calls.jsonl records every invocation's arguments.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const DIR = process.env.FAKE_DOCKER_DIR;
if (!DIR) { console.error('fake-docker: FAKE_DOCKER_DIR is not set'); process.exit(2); }
const argv = process.argv.slice(2);
for (const d of ['containers', 'volumes', 'images', 'roots']) fs.mkdirSync(path.join(DIR, d), { recursive: true });
fs.appendFileSync(path.join(DIR, 'calls.jsonl'), `${JSON.stringify(argv)}\n`);

const die = (msg, code = 1) => { process.stderr.write(`${msg}\n`); process.exit(code); };
const file = (...p) => path.join(DIR, ...p);
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const container = (name) => readJson(file('containers', `${name}.json`));
const save = (c) => fs.writeFileSync(file('containers', `${c.name}.json`), JSON.stringify(c));

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

function staged(command) {
  if (fs.existsSync(file('down'))) die('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?');
  const f = file(`fail-${command}`);
  if (!fs.existsSync(f)) return;
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
  if (lines.length <= 1) fs.unlinkSync(f); else fs.writeFileSync(f, `${lines.slice(1).join('\n')}\n`);
  die(lines[0] || `${command} failed`);
}

function killAll(c) {
  for (const pid of c.pids || []) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
  c.pids = [];
}

const [command, ...args] = argv;
staged(command === 'container' || command === 'image' || command === 'volume' || command === 'network' ? `${command}-${args[0]}` : command);

switch (command) {
  case 'version':
    console.log('0.0.0-fake');
    break;

  case 'network':
    console.log('172.17.0.1 ');
    break;

  case 'image': {
    const { rest } = parse(args.slice(1), ['--format']);
    if (args[0] === 'inspect') {
      if (!fs.existsSync(file('images', encodeURIComponent(rest[0])))) die(`Error response from daemon: No such image: ${rest[0]}`);
      console.log('sha256:fake');
    }
    break;
  }

  case 'build': {
    const { opts, rest } = parse(args, ['-t', '--progress']);
    const ms = Number(readJson(file('build-ms'))) || 0;
    console.error('#1 [internal] load build definition from Dockerfile');
    if (!fs.existsSync(path.join(rest[0], 'Dockerfile'))) die('ERROR: failed to read dockerfile');
    setTimeout(() => {
      console.error('#2 exporting to image');
      fs.writeFileSync(file('images', encodeURIComponent(opts['-t'][0])), '');
    }, ms);
    break;
  }

  case 'volume': {
    const { opts, rest } = parse(args.slice(1), ['--label', '--filter', '--format']);
    if (args[0] === 'create') {
      fs.mkdirSync(file('volumes', rest[0]), { recursive: true });
      fs.writeFileSync(file('volumes', `${rest[0]}.labels`), JSON.stringify(opts['--label'] || []));
      console.log(rest[0]);
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

  case 'run': {
    const { opts, rest } = parse(args, ['--name', '--label', '--security-opt', '--pids-limit', '--memory', '--cpus', '--add-host', '-v']);
    const name = opts['--name'][0];
    if (container(name)) die(`docker: Error response from daemon: Conflict. The container name "/${name}" is already in use.`, 125);
    if (!fs.existsSync(file('images', encodeURIComponent(rest[0])))) die(`Unable to find image '${rest[0]}' locally`, 125);
    const root = file('roots', name);
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(path.join(root, 'dn'), { recursive: true });
    const mounts = [];
    for (const v of opts['-v'] || []) {
      const [src, dst] = v.split(':');
      const host = src.startsWith('/') ? src : file('volumes', src);
      fs.mkdirSync(host, { recursive: true });
      fs.mkdirSync(path.dirname(path.join(root, dst)), { recursive: true });
      fs.symlinkSync(host, path.join(root, dst));
      mounts.push({ src, dst, host });
    }
    save({ name, image: rest[0], args, running: true, root, mounts, pids: [], labels: Object.fromEntries((opts['--label'] || []).map((l) => l.split(/=(.*)/s).slice(0, 2))) });
    console.log(`fake-${name}`);
    break;
  }

  case 'container': {
    const { rest } = parse(args.slice(1), ['--format']);
    const c = container(rest[0]);
    if (!c) die(`Error response from daemon: No such container: ${rest[0]}`);
    console.log(JSON.stringify({ State: { Running: c.running }, Config: { Image: c.image, Labels: c.labels } }));
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
      fs.mkdirSync(shims, { recursive: true });
      const shim = (n, body) => fs.writeFileSync(path.join(shims, n), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      // A detached spawn already is a session of its own.
      shim('setsid', 'exec "$@"');
      // The image's sh is dash, which is stricter than the bash a host may call sh.
      if (fs.existsSync('/bin/dash')) shim('sh', 'exec /bin/dash "$@"');
      if (spawnSync('sh', ['-c', 'command -v flock']).status !== 0) shim('flock', 'exit 0');
      shim('update-ca-certificates', [
        'for b in /etc/ssl/cert.pem /etc/ssl/certs/ca-certificates.crt; do [ -f "$b" ] && break; done',
        'mkdir -p "$DN_ROOT/etc/ssl/certs"',
        'cat "$b" "$DN_ROOT"/usr/local/share/ca-certificates/*.crt > "$DN_ROOT/etc/ssl/certs/ca-certificates.crt"',
      ].join('\n'));
    }
    const inside = (a) => {
      const m = c.mounts.find((x) => a === x.dst || a.startsWith(`${x.dst}/`));
      return m ? m.host + a.slice(m.dst.length) : a;
    };
    const env = {
      ...process.env,
      ...Object.fromEntries((opts['-e'] || []).map((kv) => kv.split(/=(.*)/s).slice(0, 2))),
      DN_ROOT: c.root,
      PATH: [process.env.FAKE_DOCKER_PATH, shims, process.env.PATH].filter(Boolean).join(':'),
    };
    const translated = cmd.map(inside);
    if (opts['-d']) {
      const child = spawn(translated[0], translated.slice(1), { env, cwd: c.root, detached: true, stdio: 'ignore' });
      child.on('error', (e) => die(`exec failed: ${e.message}`, 126));
      child.on('spawn', () => {
        c.pids.push(child.pid);
        save(c);
        child.unref();
        process.exit(0);
      });
    } else {
      const r = spawnSync(translated[0], translated.slice(1), { env, cwd: c.root, stdio: 'inherit' });
      process.exit(r.status ?? 137);
    }
    break;
  }

  default:
    die(`fake-docker: no such command: ${command}`, 2);
}
