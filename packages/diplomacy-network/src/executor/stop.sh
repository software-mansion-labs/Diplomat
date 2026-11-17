#!/bin/sh
# One job's processes, asked after or ended, with every other job in the container left
# alone. The host never runs this from a file: a job can write wherever its container
# can, so job.js puts this text on the command line of the container's /bin/sh.
#   /bin/sh -c <this text> sh up <run id> <group>     prints `up` while the runner's
#                                                     process group exists, `gone` otherwise
#   /bin/sh -c <this text> sh left <run id> <group>   the same, of anything of the job at all
#   /bin/sh -c <this text> sh stop <run id> <group> <grace seconds>
#                                                     TERM, the grace, KILL, and the job's
#                                                     work tree removed
#
# The job's process group covers what the agent started the ordinary way. Whatever left
# that group (a daemon the agent launched) still carries DN_RUN_ID in its environment,
# which is how it is found. A group of 0 is a job whose group the host does not hold:
# it is known by its run id alone.

# tr, grep, sleep and rm where the image put them, not where the container's PATH comes
# to a name first. Root in the container can still replace them there.
PATH=/usr/sbin:/usr/bin:/sbin:/bin

verb="$1"
id="$2"
pid="$3"
grace="${4:-0}"

strays() {
  for e in /proc/[0-9]*/environ; do
    p="${e#/proc/}"
    p="${p%/environ}"
    [ "$p" = "$$" ] && continue
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
