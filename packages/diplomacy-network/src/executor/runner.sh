#!/bin/sh
# One job, inside its container: the environment, the clone, the agent, the exit code.
# job.js copies this beside the job's env.sh and prompt.txt and starts it under setsid,
# so $$ names the process group stopJob signals.
#
# DN_ROOT relocates the container's own paths (/work, the certificate store); it is
# unset in a container and is how the test suite's stand-in docker runs this file on
# a host.

set -u
RUN="$(cd "$(dirname "$0")" && pwd)"
ROOT="${DN_ROOT:-}"
. "$RUN/env.sh"

JOB="$ROOT/work/jobs/$DN_RUN_ID"
CACHE="$ROOT/work/cache.git"
BUNDLE="$ROOT/etc/ssl/certs/ca-certificates.crt"
STORE="$ROOT/usr/local/share/ca-certificates"

finish() {
  printf '%s\n' "$1" > "$RUN/done.tmp" && mv "$RUN/done.tmp" "$RUN/done"
  exit 0
}
# Everything before the agent starts reports here; job.js quotes its end when a job
# never got that far.
exec > "$RUN/setup.log" 2>&1 < /dev/null
fail() { echo "dn: $1"; finish 70; }

# All traffic leaves through the broker, under this job's own token. curl reads only the
# lowercase names, most other tools either; node needs to be told to read them at all.
export HTTPS_PROXY="$DN_PROXY" HTTP_PROXY="$DN_PROXY" https_proxy="$DN_PROXY" http_proxy="$DN_PROXY"
export NO_PROXY=localhost,127.0.0.1 no_proxy=localhost,127.0.0.1
export NODE_USE_ENV_PROXY=1

# The broker's CA joins the system store once per container, under a name of its own:
# a later job may bring a newer CA while an earlier job still relies on this one.
mkdir -p "$ROOT/run" "$STORE" "$ROOT/work/jobs"
ca="dn-broker-$(cksum < "$RUN/ca.crt" | cut -d' ' -f1).crt"
(
  flock 9
  if [ ! -f "$STORE/$ca" ]; then
    cp "$RUN/ca.crt" "$STORE/$ca" && update-ca-certificates > /dev/null
  fi
) 9> "$ROOT/run/dn-ca.lock" || fail "the broker's certificate could not be installed"
export SSL_CERT_FILE="$BUNDLE" CURL_CA_BUNDLE="$BUNDLE" GIT_SSL_CAINFO="$BUNDLE"
export NODE_EXTRA_CA_CERTS="$BUNDLE" REQUESTS_CA_BUNDLE="$BUNDLE"

# git's settings are this job's own: another job in the container commits as its own
# requester and reaches the broker with its own token.
mkdir -p "$JOB" || fail "no room for the job under /work"
export GIT_CONFIG_GLOBAL="$JOB/gitconfig" GIT_TERMINAL_PROMPT=0
git config --global user.name "$DN_GIT_NAME"
git config --global user.email "$DN_GIT_EMAIL"
# Without this git asks the proxy which scheme it wants before sending the token: one
# refused request per connection.
git config --global http.proxyAuthMethod basic
git config --global advice.detachedHead false

# Placeholders, so each client sends a credential header for the broker to replace or
# drop. No real credential exists in here.
export GH_TOKEN=dn-placeholder GITLAB_TOKEN=dn-placeholder
export GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1
export IS_SANDBOX=1 DISABLE_AUTOUPDATER=1

# Each forward the job was given gets a listener on this container's loopback, and the
# variable its tool reads says where.
if [ -n "${DN_FORWARDS:-}" ]; then
  node "$RUN/forward.mjs" "$RUN/forwards.sh" $DN_FORWARDS &
  n=0
  while [ ! -f "$RUN/forwards.sh" ]; do
    n=$((n + 1))
    [ "$n" -gt 300 ] && fail "the forwards did not open"
    sleep 0.1
  done
  . "$RUN/forwards.sh"
fi

# The clone borrows from a bare copy the container keeps of the repository, so a second
# job downloads only what is new. That copy is never collected: clones point into it.
(
  flock 9
  if [ -d "$CACHE" ]; then
    git -C "$CACHE" fetch --quiet origin '+refs/heads/*:refs/heads/*' || echo "dn: the cache was not refreshed"
  else
    rm -rf "$CACHE.tmp" \
      && git clone --quiet --bare "$DN_REPO_URL" "$CACHE.tmp" \
      && git -C "$CACHE.tmp" config gc.auto 0 \
      && mv "$CACHE.tmp" "$CACHE" || echo "dn: no cache this time"
  fi
) 9> "$ROOT/work/.cache.lock"
git clone --quiet --reference-if-able "$CACHE" "$DN_REPO_URL" "$JOB/repo" || fail "the repository could not be cloned from $DN_REPO_URL"
cd "$JOB/repo" || fail "the clone is missing"
if [ -n "${DN_BASE:-}" ]; then
  { git fetch --quiet origin "$DN_BASE" && git checkout --quiet --detach FETCH_HEAD; } \
    || git checkout --quiet --detach "$DN_BASE" \
    || fail "the base revision $DN_BASE is not in the repository"
fi

# The prompt goes in on stdin: as an argument, one past the kernel's limit for a single
# argument would keep the agent from starting at all.
claude -p --dangerously-skip-permissions --output-format stream-json --verbose \
  < "$RUN/prompt.txt" > "$RUN/log.jsonl" 2> "$RUN/stderr.log"
finish $?
