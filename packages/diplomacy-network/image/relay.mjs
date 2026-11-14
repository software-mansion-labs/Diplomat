// The relay: the one way out of a job container's network. It listens on that network's
// side only and carries every connection to a single address fixed when it was started,
// the broker's. It reads nothing of what passes and takes no word from a client about
// where to go.
// usage: node relay.mjs <the job network's subnet> <port> <broker host> <broker port>

import net from 'node:net';
import os from 'node:os';

const [subnet, port, host, hostPort] = process.argv.slice(2);
const [prefix, bits] = String(subnet).split('/');
const inside = new net.BlockList();
inside.addSubnet(prefix, Number(bits), 'ipv4');
const own = Object.values(os.networkInterfaces()).flat().find((i) => i.family === 'IPv4' && inside.check(i.address));
if (!own) {
  console.error(`relay: this container has no address in ${subnet}`);
  process.exit(1);
}

const server = net.createServer((conn) => {
  const up = net.connect({ host, port: Number(hostPort) });
  for (const s of [conn, up]) {
    s.setNoDelay(true);
    s.on('error', () => {});
    s.on('close', () => { conn.destroy(); up.destroy(); });
  }
  conn.pipe(up);
  up.pipe(conn);
});
server.listen(Number(port), own.address, () => console.log(`relay: ${server.address().address}:${port} -> ${host}:${hostPort}`));
