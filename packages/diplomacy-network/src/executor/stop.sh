#!/bin/sh
# Query or end one job's processes, leaving every other job in the container alone. Never
# run from a file - a job can write wherever its container can - so job.js passes this
# text to the container's /bin/sh.
#   /bin/sh -c <this text> sh up <run id> <group>     prints `up` while the runner's
#                                                     process group exists, `gone` otherwise
#   /bin/sh -c <this text> sh left <run id> <group>   the same, of anything of the job at all
#   /bin/sh -c <this text> sh stop <run id> <group> <grace seconds>
#                                                     TERM, the grace, KILL, and the job's
#                                                     work tree removed
#
# Processes that left the job's group (a daemon the agent launched) are found by the
# DN_RUN_ID in their environment. Group 0: the host does not know the group, so only the
# run id finds the job.

# The image's tools, not whatever a job put first on the container's PATH (root in the
# container can still replace these).
PATH=/usr/sbin:/usr/bin:/sbin:/bin

verb="$1"
id="$2"
pid="$3"
grace="${4:-0}"

strays() {
  for e in /proc/[0-9]*/environ; do
    p="${e#/proc/}"
    p="${p%/environ}"
    tr '\0' '\n' 2>/dev/null < "$e" | grep -qx "DN_RUN_ID=$id" && echo "$p"
  done
}
# `-s SIG --`: dash takes no `--` after `-SIG`.
group() { [ "$pid" -gt 1 ] && kill -s "$1" -- "-$pid" 2>/dev/null; }
signal() {
  group "$1"
  for p in $(strays); do kill -s "$1" "$p" 2>/dev/null; done
}
anything() { group 0 || [ -n "$(strays)" ]; }
say() { if "$@"; then echo up; else echo gone; fi; }

case "$verb" in
  up) say group 0 ;;
  left) say anything ;;
  stop)
    signal TERM
    n=0
    while [ "$n" -lt "$grace" ] && anything; do
      sleep 1
      n=$((n + 1))
    done
    signal KILL
    rm -rf "${DN_ROOT:-}/work/jobs/$id"
    ;;
esac
exit 0
