// Loaded into a test's daemon before the daemon itself (NODE_OPTIONS=--import): the
// model provider's name resolves to an address of the public internet, as the broker
// requires of any name, and a connection to that address goes to the stand-in that
// FAKE_MODEL_PORT names on this machine. Nothing else is resolved or connected otherwise.

import dns from 'node:dns';
import net from 'node:net';

const ADDRESS = '160.79.104.10';
const port = Number(process.env.FAKE_MODEL_PORT);

const { lookup } = dns.promises;
dns.promises.lookup = (host, ...rest) => (host === 'api.anthropic.com' ? Promise.resolve([{ address: ADDRESS, family: 4 }]) : lookup(host, ...rest));

const { connect } = net;
net.connect = (options, ...rest) => (options?.host === ADDRESS ? connect({ ...options, host: '127.0.0.1', port }, ...rest) : connect(options, ...rest));
