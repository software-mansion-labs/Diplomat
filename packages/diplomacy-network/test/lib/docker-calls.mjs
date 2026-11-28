// What the stand-in docker (fake-docker.mjs) was called with, in order: calls.jsonl, a call
// to a line. A call may be writing its line while this reads it, so what follows the last
// newline is no call yet.

import fs from 'node:fs';
import path from 'node:path';

export const dockerCalls = (dir) => fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').split('\n').slice(0, -1).map((l) => JSON.parse(l));
