// What the processes of this pid namespace hold of the disk in files that have no name
// left: a file its writer unlinked and keeps open is in no directory for `du` to find,
// and its blocks stay taken until the last descriptor on it is closed. container.js puts
// this text on the command line of a node beside a job container, in that container's
// pid namespace. It prints `held <bytes>`, or `blind` where a process's descriptors are
// not this one's to read.
//
// Counted is what a descriptor or a running program names. What only a mapping holds,
// or a descriptor on its way through a unix socket, is in neither place.
const fs = require('node:fs');

// tmpfs (shared memory and memfd among it), ramfs and hugetlbfs hold memory, which the
// container's memory limit bounds.
const MEMORY = new Set([0x01021994, 0x858458f6, 0x958458f6]);
const DENIED = new Set(['EACCES', 'EPERM']);
const seen = new Set();
let bytes = 0;
let blind = false;
for (const pid of fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
  let open = [];
  // A process that ended meanwhile holds nothing; one that may not be read is known by
  // its program below.
  try { open = fs.readdirSync(`/proc/${pid}/fd`).map((fd) => `fd/${fd}`); } catch {}
  for (const name of [...open, 'exe']) {
    try {
      const st = fs.statSync(`/proc/${pid}/${name}`);
      if (st.nlink !== 0 || !st.isFile() || seen.has(`${st.dev}:${st.ino}`)) continue;
      seen.add(`${st.dev}:${st.ino}`);
      if (!MEMORY.has(fs.statfsSync(`/proc/${pid}/${name}`).type)) bytes += st.blocks * 512;
    } catch (e) { blind ||= DENIED.has(e.code); }
  }
}
console.log(blind ? 'blind' : `held ${bytes}`);
