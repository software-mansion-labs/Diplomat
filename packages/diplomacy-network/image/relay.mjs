// The one way out of a job container's network: listens on that network only and carries
// every connection to the broker address fixed at start, reading nothing and taking no
// destination from a client. The container's connection limits live here, the one place
// that knows a connection's container before any of it is read.
// usage: node relay.mjs <the job network's subnet> <port> <broker host> <broker port>

import net from 'node:net';
import os from 'node:os';

const AT_A_TIME = 1024;
// A token bucket for new connections, the excess queued in order: each one carried takes a
// port on the broker's machine, which stays unusable for a while after it closes.
const BURST = 256;
const PER_SECOND = 64;
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

// The hop's framing and credit flow control: see src/executor/hop.js.
const PREFACE = Buffer.from([0, 0x64, 0x6e, 1]);
const DATA = 0;
const END = 1;
const ASK = 2;
const CREDIT = 3;
const ACK = 5;

function carry(conn) {
  const up = net.connect({ host, port: Number(hostPort) });
  up.on('error', () => {});
  // A hop closed without the broker's END was cut short: reset the client so it never
  // takes what came as all there was.
  const gone = () => { conn.resetAndDestroy(); up.destroy(); };
  // Closing a socket whose far end still sends resets it, losing what it had not read:
  // end it instead, and close once the far end ends too or LINGER_MS on.
  const linger = (s) => {
    s.end();
    setTimeout(() => s.destroy(), LINGER_MS).unref();
  };
  // Each way ends on its own and the broker closes the hop once both have; a client close
  // before both ways ended is the client gone.
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
  let waiting = null; // from the client, not yet sent
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

  let passed = 0; // broker bytes the client's socket took, not yet ACKed
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

const server = net.createServer({ pauseOnConnect: true, allowHalfOpen: true }, (conn) => {
  conn.on('error', () => {});
  waiting.push(conn);
  if (!timer) admit();
});
// A relay that exits leaves its jobs no way out, so nothing a job does may end it: a
// connection that cannot be accepted is one connection lost.
server.maxConnections = AT_A_TIME;
server.on('error', (e) => {
  console.error(`relay: ${e.message}`);
  if (!server.listening) process.exit(1);
});
server.listen(Number(port), own.address, () => console.log(`relay: ${server.address().address}:${port} -> ${host}:${hostPort}`));
