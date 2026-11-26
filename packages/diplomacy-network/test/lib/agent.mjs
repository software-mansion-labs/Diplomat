// A stand-in for the agent, for jobs that must not need a model: it is started the way
// runner.sh starts `claude`, and does what the requester's prompt spells out, one step
// per line after the preamble:
//
//   api <METHOD> <path> [json]   a forge API request, as gh or glab makes it: through the
//                                proxy, to the pool's forge
//   model                        one request to the model provider, as the agent's own
//                                client makes it: through the proxy, with a placeholder key
//   push <branch>                a commit on top of the clone, pushed to that branch
//   adb                          asks the forwarded adb server for its version and devices,
//                                and to connect to an address for it
//   wait <name>                  until the file <name> exists in FAKE_AGENT_DIR
//   plant <file> <text>          writes <text> over <file> in the job's run directory
//   deaf                         ignores SIGTERM from here on
//   child                        leaves a process of its own session behind, its pid kept
//   say <text>                   the result's text
//   says <JSON string>           the result's text, with whatever a line of a script cannot hold
//   fail                         ends as an agent that reports an error
//   unsent                       sends the model provider nothing for what the result names
//   result                       the result now, with the steps after it still to come
//
// What each step got is kept in FAKE_AGENT_DIR/<run id>.json as it goes, with the
// agent's pid and its environment, and the stream ends with a result that names a cost
// and tokens. Where the model provider is stood in for (FAKE_MODEL_PORT), it has sent the
// provider a request by then that could have held them: the host counts neither figure
// above what it carried to the model for the job (job.js).

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { execFileSync, spawn } from 'node:child_process';

const dir = process.env.FAKE_AGENT_DIR;
const runId = process.env.DN_RUN_ID;
const record = { runId, pid: process.pid, cwd: process.cwd(), steps: [], env: { ...process.env } };
const save = () => {
  fs.writeFileSync(path.join(dir, `${runId}.tmp`), JSON.stringify(record));
  fs.renameSync(path.join(dir, `${runId}.tmp`), path.join(dir, `${runId}.json`));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (...args) => {
  try {
    return { code: 0, out: execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}`.trim() };
  }
};

// A job is told its forge's host unless that is github.com, whose API is on api.github.com.
const forgeHost = process.env.GITLAB_HOST || process.env.GH_HOST || 'api.github.com';
const credential = process.env.GITLAB_HOST ? { 'private-token': process.env.GITLAB_TOKEN } : { authorization: `token ${process.env.GH_TOKEN}`, accept: 'application/vnd.github+json' };

function api(method, route, body, host = forgeHost, headers = credential) {
  const proxy = new URL(process.env.HTTPS_PROXY);
  const auth = Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64');
  return new Promise((resolve) => {
    const failed = (err) => resolve({ status: 0, body: String(err?.message ?? err) });
    const connect = http.request({
      host: proxy.hostname, port: proxy.port, method: 'CONNECT', path: `${host}:443`,
      headers: { host: `${host}:443`, 'proxy-authorization': `Basic ${auth}` },
    });
    connect.on('error', failed);
    connect.on('connect', (res, socket) => {
      if (res.statusCode !== 200) return failed(new Error(`the proxy answered ${res.statusCode}`));
      const req = https.request({
        host, path: route, method,
        createConnection: () => tls.connect({ socket, servername: host, ca: fs.readFileSync(process.env.SSL_CERT_FILE) }),
        headers: {
          ...headers, 'user-agent': 'stand-in-agent',
          ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
        },
      }, (answer) => {
        const chunks = [];
        answer.on('data', (c) => chunks.push(c));
        answer.on('end', () => {
          const said = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(said); } catch {}
          resolve({ status: answer.statusCode, body: json ?? said });
        });
      });
      req.on('error', failed);
      req.end(body);
      return undefined;
    });
    connect.end();
  });
}

function adb(service) {
  const [host, port] = String(process.env.ADB_SERVER_SOCKET ?? '').replace(/^tcp:/, '').split(':');
  return new Promise((resolve) => {
    if (!port) return resolve('no ADB_SERVER_SOCKET');
    const socket = net.connect(Number(port), host);
    let said = '';
    socket.on('data', (c) => { said += c.toString('latin1'); });
    socket.on('error', (err) => resolve(`error: ${err.message}`));
    socket.on('close', () => resolve(said));
    socket.on('connect', () => socket.write(`${service.length.toString(16).padStart(4, '0')}${service}`));
    return undefined;
  });
}

// The model provider's headers, as the agent's own client sends them: the key is a placeholder.
const provider = { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' };

const prompt = fs.readFileSync(0, 'utf8');
record.prompt = prompt;
save();
console.log('{"type":"system","subtype":"init","model":"stand-in"}');

let result = 'done';
let ok = true;
let unsent = false;
let said = false;

async function conclude() {
  // 6000 bytes: more than the 120 tokens, and than the 5250 that USD 0.42 is the price of.
  const body = JSON.stringify({ model: 'stand-in', max_tokens: 1, messages: [], pad: 'x'.repeat(5942) });
  if (process.env.FAKE_MODEL_PORT && !unsent) record.spent = await api('POST', '/v1/messages', body, 'api.anthropic.com', provider);
  console.log(JSON.stringify({
    type: 'result', subtype: ok ? 'success' : 'error_during_execution', is_error: !ok, result, total_cost_usd: 0.42,
    usage: { input_tokens: 100, output_tokens: 20 },
  }));
  said = true;
}

for (const line of prompt.slice(prompt.lastIndexOf('\n---\n') + 5).split('\n')) {
  const [verb, ...rest] = line.trim().split(' ');
  const step = { verb, args: rest };
  if (verb === 'api') {
    const [method, route, ...json] = rest;
    Object.assign(step, await api(method, route, json.length > 0 ? json.join(' ') : undefined));
  } else if (verb === 'model') {
    Object.assign(step, await api('POST', '/v1/messages', '{"model":"stand-in","max_tokens":1,"messages":[]}', 'api.anthropic.com', provider));
  } else if (verb === 'push') {
    fs.writeFileSync(`${rest[0].replace(/\W/g, '-')}.txt`, `${runId}\n`);
    git('add', '-A');
    git('commit', '--quiet', '-m', `work of ${runId}`);
    step.author = git('log', '-1', '--format=%an <%ae>').out;
    Object.assign(step, git('push', '--quiet', 'origin', `HEAD:refs/heads/${rest[0]}`));
  } else if (verb === 'adb') {
    step.version = await adb('host:version');
    step.devices = await adb('host:devices');
    step.connect = await adb('host:connect:127.0.0.1:1');
  } else if (verb === 'plant') {
    // DN_ROOT is where the stand-in docker keeps a container's own paths.
    fs.writeFileSync(path.join(process.env.DN_ROOT ?? '/', 'dn', 'runs', runId, rest[0]), `${rest.slice(1).join(' ')}\n`);
  } else if (verb === 'deaf') {
    process.on('SIGTERM', () => {});
  } else if (verb === 'child') {
    const child = spawn('sleep', ['600'], { detached: true, stdio: 'ignore' });
    child.unref();
    step.pid = child.pid;
  } else if (verb === 'wait') {
    record.waiting = rest[0];
    save();
    while (!fs.existsSync(path.join(dir, rest[0]))) await sleep(50);
    record.waiting = null;
  } else if (verb === 'say') {
    result = rest.join(' ');
  } else if (verb === 'says') {
    result = JSON.parse(rest.join(' '));
  } else if (verb === 'fail') {
    ok = false;
  } else if (verb === 'unsent') {
    unsent = true;
  } else if (verb === 'result') {
    await conclude();
  } else continue;
  record.steps.push(step);
  save();
}

if (!said) await conclude();
record.ended = true;
save();
process.exit(ok ? 0 : 1);
