// The host's adb server as a job is given it. The server does far more than talk to
// devices: asked, it opens TCP connections from this machine (`host:connect`), listens on
// this machine's ports (`host:forward`), pairs, and exits (`host:kill`), and a device
// asked for `reverse:` is given a way to this machine's ports. So a job's forward does
// not lead to the server but to this filter in front of it, which reads each connection's
// requests in adb's own framing (four hex digits of length, then the request) and passes
// on only these:
//   host:version, host:devices, host:devices-l, host:features, host:host-features
//   host-serial:<serial>:get-state | get-serialno | get-devpath | features
//   host:transport:<serial>, host:tport:serial:<serial>, and after either the one
//   request to the device itself (shell:, exec:, sync:, ...)
// Anything else is answered `FAIL` with the reason and never reaches the server. That
// includes, after a switch to a device, `reverse:` and every `host` request: the server
// reads the request behind a switch the way it read the first. And it includes whatever
// follows one of the first two lines on the same connection.

import net from 'node:net';

const SERIAL = '(?:[A-Za-z0-9._-]+|\\[[0-9A-Fa-f:.]+\\])(?::\\d{1,5})?';
const QUERY = new RegExp(`^(?:host:(?:version|devices|devices-l|features|host-features)|host-serial:${SERIAL}:(?:get-state|get-serialno|get-devpath|features))$`);
const DEVICE = new RegExp(`^host:(?:transport|tport:serial):${SERIAL}$`);
const NOT_THE_DEVICES = /^(?:host[-:]|reverse:)/;

// An adb client whose version is not the server's opens with a request to stop the
// server, to start one of its own in its place.
const KILL_WHY = ' (adb asks for this when its version is not the server\'s: this machine\'s adb server is not replaced, so use an adb of the server\'s version)';

const frame = (text) => `${Buffer.byteLength(text, 'latin1').toString(16).padStart(4, '0')}${text}`;

/// What a connection's first request is to the filter: `query` (answered by the server,
/// and the connection's last), `device` (a switch to one device, after which one more
/// request is passed on) or null (refused).
export function adbRequest(service) {
  return QUERY.test(service) ? 'query' : DEVICE.test(service) ? 'device' : null;
}

/// The serials of the devices the adb server at `target` (`{ host, port }`) lists as
/// ready for use, or null when no adb server answers there. Asked in adb's own words:
/// some other listener on that port is nothing to hand a job.
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
      // One device a line: its serial, a tab, its state.
      const lines = said.slice(8, 8 + size).split('\n').map((line) => line.split('\t'));
      return done(lines.filter(([, state]) => state === 'device').map(([serial]) => serial));
    });
    socket.on('close', () => resolve(null));
    return undefined;
  });
}

function serve(client, target, log) {
  let pending = Buffer.alloc(0);
  let stage = 'first'; // then `device` after a switch to one, `query` after a query
  let server = null;
  client.on('error', () => {});
  client.on('close', () => server?.destroy());

  // One whole request off the front of what was read: null while it is not all there,
  // false when what is there is not adb's framing.
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
    // A job's own words, cut short and made printable for the log.
    const what = service === false ? 'a request that is not in adb\'s framing' : service.slice(0, 60).replace(/[^\x20-\x7e]/g, '?');
    log('adb', `refused a job: ${what}`);
    client.off('data', read);
    client.end(`FAIL${frame(`not offered to a task on this machine: ${what}${service === 'host:kill' && stage === 'first' ? KILL_WHY : ''}`)}`);
    // A client that never closes its side is not waited for.
    client.setTimeout(5000, () => client.destroy());
    server?.destroy();
  };

  function read(chunk) {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      const service = next();
      if (service === null) return undefined;
      // Behind a switch, the device's own services; behind a query, nothing.
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
        // The device's own service from here on: whatever follows is its stream.
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

/// The filter in front of the adb server at `target` (`{ host, port }`). `start()`
/// resolves to where it listens on this machine's loopback, `{ host, port }`, the same
/// place every time; `stop()` ends it and every connection through it.
export function createAdbFilter({ target, log = () => {} }) {
  const sockets = new Set();
  const listener = net.createServer((client) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    serve(client, target, log);
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
