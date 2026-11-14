#!/bin/sh
# Ends one job's processes and removes its work tree, leaving every other job in the
# container alone. usage: stop.sh <run id> <grace seconds>
#
# The job's process group covers what the agent started the ordinary way. Whatever left
# that group (a daemon the agent launched) still carries DN_RUN_ID in its environment,
# which is how it is found.

RUN="$(cd "$(dirname "$0")" && pwd)"
id="$1"
grace="$2"
pid="$(cat "$RUN/pid" 2>/dev/null)"

strays() {
  for e in /proc/[0-9]*/environ; do
    p="${e#/proc/}"
    p="${p%/environ}"
    [ "$p" = "$$" ] && continue
    tr '\0' '\n' < "$e" 2>/dev/null | grep -qx "DN_RUN_ID=$id" && echo "$p"
  done
}
# `-s SIG --`: dash takes no `--` after `-SIG`.
group() { [ -n "$pid" ] && kill -s "$1" -- "-$pid" 2>/dev/null; }
signal() {
  group "$1"
  for p in $(strays); do kill -s "$1" "$p" 2>/dev/null; done
}

signal TERM
n=0
while [ "$n" -lt "$grace" ] && { group 0 || [ -n "$(strays)" ]; }; do
  sleep 1
  n=$((n + 1))
done
signal KILL
rm -rf "${DN_ROOT:-}/work/jobs/$id"
exit 0
