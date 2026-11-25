// Disk held by this pid namespace's processes in unlinked-but-open files, which `du`
// cannot see. container.js runs this text via `node -e` in a job container's pid
// namespace, so it must stay self-contained. Prints `held <bytes>`, or `blind` when some
// process's descriptors are not ours to read.
//
// Every thread's fd table is read: a process whose first thread ended shows its
// descriptors only under the others, and a thread can have a table of its own. Files held
// only by a mapping or by a descriptor in flight over a unix socket are missed.
const fs = require('node:fs');

// tmpfs (incl. shm and memfd), ramfs, hugetlbfs: memory, bounded by the memory limit.
const MEMORY = new Set([0x01021994, 0x858458f6, 0x958458f6]);
const DENIED = new Set(['EACCES', 'EPERM']);
const seen = new Set();
let bytes = 0;
let blind = false;
for (const pid of fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
  const open = [`/proc/${pid}/exe`];
  // An ended process holds nothing; an unreadable one is caught as blind by its exe.
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
