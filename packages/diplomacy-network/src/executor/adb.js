// A job's adb forward leads to this filter, not to the host's adb server, which does far
// more than talk to devices: it opens TCP connections (`host:connect`), listens on ports
// (`host:forward`), pairs, exits (`host:kill`), and `reverse:` gives a device a way to
// this machine's ports. Only these pass:
//   host:version, host:devices, host:devices-l, host:features, host:host-features
//   host-serial:<serial>:get-state | get-serialno | get-devpath | features
//   host:transport:<serial>, host:tport:serial:<serial>, then one request to the device
//   itself (shell:, exec:, sync:, ...)
// Anything else gets FAIL: that includes `reverse:` and any `host` request after a switch
// (the server parses those as it does a first request), and anything after a query.

import net from 'node:net';
import { createSparingLog } from './sparing.js';

const SERIAL = '(?:[A-Za-z0-9._-]+|\\[[0-9A-Fa-f:.]+\\])(?::\\d{1,5})?';
const QUERY = new RegExp(`^(?:host:(?:version|devices|devices-l|features|host-features)|host-serial:${SERIAL}:(?:get-state|get-serialno|get-devpath|features))$`);
const DEVICE = new RegExp(`^host:(?:transport|tport:serial):${SERIAL}$`);
const NOT_THE_DEVICES = /^(?:host[-:]|reverse:)/;

// An adb client of another version than the server's opens with host:kill, to replace it.
const KILL_WHY = ' (adb asks for this when its version is not the server\'s: this machine\'s adb server is not replaced, so use an adb of the server\'s version)';

// `text` is latin1, so its length is its byte count.
const frame = (text) => Buffer.from(`${text.length.toString(16).padStart(4, '0')}${text}`, 'latin1');

export function adbRequest(service) {
  return QUERY.test(service) ? 'query' : DEVICE.test(service) ? 'device' : null;
}

/// null unless an adb server answers at `target`: another listener there is nothing to
/// hand a job.
export function adbDevices(target) {
  return new Promise((resolve) => {
    if (!target) return resolve(null);
    const socket = net.connect(target);
    let said = '';
    const done = (answer) => { socket.destroy(); resolve(answer); };
    socket.setTimeout(2000, () => done(null));
    socket.on('error', () => done(null));
    socket.on('connect', () => socket.write(frame('host:devices')));
    socket.on('data', (chunk) => {
      said += chunk.toString('latin1');
      if (said.length < 8 && 'OKAY'.startsWith(said.slice(0, 4))) return undefined;
      const size = /^OKAY[0-9A-Fa-f]{4}/.test(said) ? parseInt(said.slice(4, 8), 16) : NaN;
      if (Number.isNaN(size)) return done(null);
      if (said.length < 8 + size) return undefined;
      const lines = said.slice(8, 8 + size).split('\n').map((line) => line.split('\t'));
      return done(lines.filter(([, state]) => state === 'device').map(([serial]) => serial));
    });
    socket.on('close', () => resolve(null));
    return undefined;
  });
}

function serve(client, target, sparing) {
  let pending = Buffer.alloc(0);
  let stage = 'first';
  let server = null;
  client.on('error', () => {});
  client.on('close', () => server?.destroy());

  // null: not all read yet; false: not adb's framing.
  const next = () => {
    if (pending.length < 4) return null;
    const head = pending.subarray(0, 4).toString('latin1');
    if (!/^[0-9A-Fa-f]{4}$/.test(head)) return false;
    const end = 4 + parseInt(head, 16);
    if (pending.length < end) return null;
    const service = pending.subarray(4, end).toString('latin1');
    pending = pending.subarray(end);
    return service;
  };
  const refuse = (service) => {
    const what = service === false ? 'a request that is not in adb\'s framing' : service.slice(0, 60).replace(/[^\x20-\x7e]/g, '?');
    sparing('refused', 'adb', `refused a job: ${what}`);
    client.off('data', read);
    client.end(Buffer.concat([Buffer.from('FAIL'), frame(`not offered to a task on this machine: ${what}${service === 'host:kill' && stage === 'first' ? KILL_WHY : ''}`)]));
    client.setTimeout(5000, () => client.destroy());
    server?.destroy();
  };

  function read(chunk) {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      const service = next();
      if (service === null) return undefined;
      const kind = service === false ? null : stage === 'first' ? adbRequest(service) : stage === 'device' && !NOT_THE_DEVICES.test(service) ? 'open' : null;
      if (!kind) return refuse(service);
      if (!server) {
        server = net.connect(target);
        server.on('error', () => {});
        server.on('close', () => client.end());
        server.pipe(client);
      }
      server.write(frame(service));
      if (kind === 'open') {
        client.off('data', read);
        if (pending.length > 0) server.write(pending);
        client.pipe(server);
        return undefined;
      }
      stage = kind;
    }
  }
  client.on('data', read);
}

export function createAdbFilter({ target, log = () => {}, now = Date.now }) {
  const sparing = createSparingLog(log, { now });
  const sockets = new Set();
  const listener = net.createServer((client) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    serve(client, target, sparing);
  });
  let listening = null;

  function start() {
    listening ??= new Promise((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', () => resolve({ host: '127.0.0.1', port: listener.address().port }));
    });
    return listening;
  }

  async function stop() {
    if (!listening) return;
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => listener.close(resolve));
  }

  return { start, stop };
}
