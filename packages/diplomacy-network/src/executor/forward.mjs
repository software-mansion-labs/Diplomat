// Inside a job's container: one loopback listener per forward the job was given. A
// connection to it becomes a CONNECT to <name>.forward.dn through the broker under the
// job's own token, which is what makes a forward this job's and no other container's.
// The listeners' addresses are written to <env file> as the variables a tool reads:
// `adb` as ADB_SERVER_SOCKET, anything else as DN_FORWARD_<NAME>=host:port. The device
// allocator and the tool-server are to be offered to a job through here.
// usage: node forward.mjs <env file> <name>...   with DN_PROXY in the environment

import fs from 'node:fs';
import net from 'node:net';

const [envFile, ...names] = process.argv.slice(2);
const proxy = new URL(process.env.DN_PROXY);
const auth = Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64');

function listen(name) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((conn) => {
      const up = net.connect({ host: proxy.hostname, port: Number(proxy.port) });
      for (const s of [conn, up]) {
        s.on('error', () => {});
        s.on('close', () => { conn.destroy(); up.destroy(); });
      }
      up.write(`CONNECT ${name}.forward.dn:1 HTTP/1.1\r\nHost: ${name}.forward.dn:1\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
      let head = Buffer.alloc(0);
      const answer = (chunk) => {
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf('\r\n\r\n');
        if (end < 0) return;
        up.off('data', answer);
        if (!/^HTTP\/1\.[01] 200 /.test(head.toString('latin1', 0, 13))) return conn.destroy();
        if (head.length > end + 4) conn.write(head.subarray(end + 4));
        up.pipe(conn);
        conn.pipe(up);
      };
      up.on('data', answer);
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

const lines = [];
for (const name of names) {
  const at = `127.0.0.1:${await listen(name)}`;
  lines.push(name === 'adb' ? `export ADB_SERVER_SOCKET=tcp:${at}` : `export DN_FORWARD_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}=${at}`);
}
fs.writeFileSync(`${envFile}.tmp`, `${lines.join('\n')}\n`);
fs.renameSync(`${envFile}.tmp`, envFile);
