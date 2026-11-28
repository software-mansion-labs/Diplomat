// The stand-in docker's calls.jsonl, a call to a line, in order. A call may be writing its
// line while this reads it: what follows the last newline is no call yet.

import fs from 'node:fs';
import path from 'node:path';

export const dockerCalls = (dir) => fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').split('\n').slice(0, -1).map((l) => JSON.parse(l));
