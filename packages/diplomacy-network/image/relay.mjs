// The relay: the one way out of a job container's network. It listens on that network's
// side only and carries every connection to a single address fixed when it was started,
// the broker's. It reads nothing of what passes and takes no word from a client about
// where to go. What its container may ask of the broker in connections is bounded here,
// the one place that knows a connection for that container's before anything is read
// of it: so many at a time, and so many new ones in a second.
// usage: node relay.mjs <the job network's subnet> <port> <broker host> <broker port>

import net from 'node:net';
import os from 'node:os';

// Connections carried or waiting to be, at a time: past this many a new one is dropped.
const AT_A_TIME = 1024;
// A new connection is carried at once while the allowance lasts: BURST of them, which
// come back at PER_SECOND a second. One that comes when none is left waits its turn
// behind those before it. Every one that is carried takes a port of the machine the
// broker runs on, which that machine keeps from other use for a while after the
// connection has closed.
const BURST = 256;
const PER_SECOND = 64;
// How long a connection's side that has ended waits for its far end to end too.
const LINGER_MS = 5000;

const [subnet, port, host, hostPort] = process.argv.slice(2);
const [prefix, bits] = String(subnet).split('/');
const inside = new net.BlockList();
inside.addSubnet(prefix, Number(bits), 'ipv4');
const own = Object.values(os.networkInterfaces()).flat().find((i) => i.family === 'IPv4' && inside.check(i.address));
if (!own) {
  console.error(`relay: this container has no address in ${subnet}`);
  process.exit(1);
}

// The hop to the broker carries each connection in frames (src/executor/hop.js says
// how): the client's bytes go only as far as the broker has made room for them, and
// the broker is told of each of its bytes once the client's socket has taken it. What
// waits is kept by the client's own socket.
const PREFACE = Buffer.from([0, 0x64, 0x6e, 1]);
const DATA = 0;
const END = 1;
const ASK = 2;
const CREDIT = 3;
const ACK = 5;

function carry(conn) {
  const up = net.connect({ host, port: Number(hostPort) });
  up.on('error', () => {});
  // A hop closed without the broker's END is a connection cut short: the client is reset,
  // so that it never reads what came as all there was.
  const gone = () => { conn.resetAndDestroy(); up.destroy(); };
  // A socket closed while its far end still sends is reset, and that end loses what it
  // had not read yet: a side whose bytes came to their end is ended instead, and closed
  // once its far end has ended too, or LINGER_MS on.
  const linger = (s) => {
    s.end();
    setTimeout(() => s.destroy(), LINGER_MS).unref();
  };
  // Each way ends on its own: the client's end goes to the broker as END once what came
  // before it is sent, and the broker's to the client as its socket's end. The broker
  // ends the hop once both ways have. The client's socket closes once both have too,
  // what it wrote perhaps still waiting for room to be sent; any other close is the
  // client gone.
  let brokerEnded = false;
  conn.on('close', () => { if (!conn.readableEnded || !brokerEnded) gone(); });
  up.on('close', () => (brokerEnded ? linger(conn) : gone()));
  for (const s of [conn, up]) s.setNoDelay(true);
  const frame = (type, n, payload) => {
    const head = Buffer.allocUnsafe(5);
    head[0] = type;
    head.writeUInt32BE(n, 1);
    up.cork();
    up.write(head);
    if (payload) up.write(payload);
    up.uncork();
  };
  up.write(PREFACE);

  let credit = 0;
  let waiting = null; // read from the client, not yet sent
  let ended = false;
  const send = () => {
    while (waiting && credit > 0) {
      const n = Math.min(credit, waiting.length);
      frame(DATA, n, waiting.subarray(0, n));
      credit -= n;
      waiting = n < waiting.length ? waiting.subarray(n) : null;
    }
    if (waiting) frame(ASK, waiting.length);
    else if (ended) {
      ended = false;
      frame(END, 0);
    } else conn.resume();
  };
  conn.on('data', (chunk) => {
    conn.pause();
    waiting = chunk;
    send();
  });
  conn.on('end', () => {
    ended = true;
    if (!waiting) send();
  });

  let passed = 0; // of the broker's bytes, taken by the client's socket and not yet told
  const told = () => {
    frame(ACK, passed);
    passed = 0;
  };
  const taken = (n) => () => {
    if (passed === 0) setImmediate(told);
    passed += n;
  };
  let kept = null;
  up.on('data', (chunk) => {
    const buf = kept ? Buffer.concat([kept, chunk]) : chunk;
    let at = 0;
    while (buf.length - at >= 5) {
      const type = buf[at];
      const n = buf.readUInt32BE(at + 1);
      if (type === DATA) {
        if (buf.length - at < 5 + n) break;
        conn.write(buf.subarray(at + 5, at + 5 + n), taken(n));
        at += 5 + n;
        continue;
      }
      at += 5;
      if (type === CREDIT) {
        credit += n;
        send();
      } else if (type === END) {
        brokerEnded = true;
        conn.end();
      } else return gone();
    }
    kept = at < buf.length ? buf.subarray(at) : null;
    return undefined;
  });
  conn.resume();
}

let allowance = BURST;
let counted = Date.now();
const waiting = [];
let timer = null;

// Carries those that wait, the longest first, as far as the allowance goes, and comes
// back for the rest when there is allowance for one more.
function admit() {
  timer = null;
  const now = Date.now();
  allowance = Math.min(BURST, allowance + (now - counted) * PER_SECOND / 1000);
  counted = now;
  while (waiting.length > 0 && allowance >= 1) {
    allowance -= 1;
    carry(waiting.shift());
  }
  if (waiting.length > 0) timer = setTimeout(admit, Math.ceil((1 - allowance) * 1000 / PER_SECOND));
}

// Nothing is read of a connection before it is carried.
const server = net.createServer({ pauseOnConnect: true, allowHalfOpen: true }, (conn) => {
  conn.on('error', () => {});
  waiting.push(conn);
  if (!timer) admit();
});
// A relay that ended would leave its container's jobs with no way out, so nothing a
// job does to it ends it: a connection that cannot be accepted is one connection lost.
server.maxConnections = AT_A_TIME;
server.on('error', (e) => {
  console.error(`relay: ${e.message}`);
  if (!server.listening) process.exit(1);
});
server.listen(Number(port), own.address, () => console.log(`relay: ${server.address().address}:${port} -> ${host}:${hostPort}`));
