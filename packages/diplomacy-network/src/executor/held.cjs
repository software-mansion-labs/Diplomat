// What the processes of this pid namespace hold of the disk in files that have no name
// left: a file its writer unlinked and keeps open is in no directory for `du` to find,
// and its blocks stay taken until the last descriptor on it is closed. container.js puts
// this text on the command line of a node beside a job container, in that container's
// pid namespace. It prints `held <bytes>`, or `blind` where a process's descriptors are
// not this one's to read.
//
// Counted is what a descriptor of any of a process's threads or a running program names:
// a process whose first thread ended shows its descriptors only under the others, and a
// thread can hold a table of its own. What only a mapping holds, or a descriptor on its
// way through a unix socket, is in neither place.
const fs = require('node:fs');

// tmpfs (shared memory and memfd among it), ramfs and hugetlbfs hold memory, which the
// container's memory limit bounds.
const MEMORY = new Set([0x01021994, 0x858458f6, 0x958458f6]);
const DENIED = new Set(['EACCES', 'EPERM']);
const seen = new Set();
let bytes = 0;
let blind = false;
for (const pid of fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
  const open = [`/proc/${pid}/exe`];
  // A process or a thread that ended meanwhile holds nothing; one that may not be read
  // is known by its program.
  let tasks = [];
  try { tasks = fs.readdirSync(`/proc/${pid}/task`); } catch {}
  for (const tid of tasks) {
    const dir = `/proc/${pid}/task/${tid}/fd`;
    try { open.push(...fs.readdirSync(dir).map((fd) => `${dir}/${fd}`)); } catch {}
  }
  for (const at of open) {
    try {
      const st = fs.statSync(at);
      if (st.nlink !== 0 || !st.isFile() || seen.has(`${st.dev}:${st.ino}`)) continue;
      seen.add(`${st.dev}:${st.ino}`);
      if (!MEMORY.has(fs.statfsSync(at).type)) bytes += st.blocks * 512;
    } catch (e) { blind ||= DENIED.has(e.code); }
  }
}
console.log(blind ? 'blind' : `held ${bytes}`);
