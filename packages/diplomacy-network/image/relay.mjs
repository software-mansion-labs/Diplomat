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

const [subnet, port, host, hostPort] = process.argv.slice(2);
const [prefix, bits] = String(subnet).split('/');
const inside = new net.BlockList();
inside.addSubnet(prefix, Number(bits), 'ipv4');
const own = Object.values(os.networkInterfaces()).flat().find((i) => i.family === 'IPv4' && inside.check(i.address));
if (!own) {
  console.error(`relay: this container has no address in ${subnet}`);
  process.exit(1);
}

function carry(conn) {
  const up = net.connect({ host, port: Number(hostPort) });
  up.on('error', () => {});
  for (const s of [conn, up]) {
    s.on('close', () => { conn.destroy(); up.destroy(); });
    s.setNoDelay(true);
  }
  conn.pipe(up);
  up.pipe(conn);
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
const server = net.createServer({ pauseOnConnect: true }, (conn) => {
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
