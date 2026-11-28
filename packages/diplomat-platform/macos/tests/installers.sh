#!/usr/bin/env bash
# What install-autostart.sh, install-autoupdate.sh and install-watchdog.sh write. Runs
# a copy of install/ laid out as a scratch checkout, with HOME in it too: `swift` is a stub, so
# build-app.sh lays the bundle out without a build, and it commits, as a checkout moving
# during a compile would; the binary it lays out is a stub that logs its runs, so an
# agent's ProgramArguments are run as launchd runs them; launchctl and pkill are stubs
# that log their arguments; and `rm` refuses anything outside the scratch dir, which
# keeps the run off this box's /Applications and is the failure the installer's
# "delete it by hand" arm is for. The Linux twin is linux/tests/test_install_autoupdate.py.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SCRATCH="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/diplomat-installers.XXXXXX")" && pwd -P)"
trap 'rm -rf "$SCRATCH"' EXIT
export SCRATCH

PKG="$SCRATCH/packages/diplomat-platform/macos"
BIN="$PKG/Diplomat.app/Contents/MacOS/Diplomat"
AGENTS="$SCRATCH/home/Library/LaunchAgents"
LAUNCHER="$SCRATCH/home/Library/Application Support/Diplomat/Diplomat"
mkdir -p "$PKG" "$SCRATCH/packages/diplomat-core/assets" "$SCRATCH/home" "$SCRATCH/bin" "$SCRATCH/build"
cp -R "$HERE/../install" "$PKG/install"
GIT=(git -C "$SCRATCH" -c user.name=installers -c user.email=installers@localhost)
"${GIT[@]}" init -q && "${GIT[@]}" commit -q --allow-empty -m "before install/"
BEFORE="$("${GIT[@]}" rev-parse HEAD)"
# As a clone with core.symlinks=false lays it out: a symlink is a file naming its target.
for f in "$PKG"/install/*; do
  if [ -L "$f" ]; then t="$(readlink "$f")" && /bin/rm "$f" && printf %s "$t" > "$f"; fi
done
"${GIT[@]}" add packages && "${GIT[@]}" commit -q -m checkout
COMPILED="$("${GIT[@]}" rev-parse HEAD)"
printf '#!/bin/sh\necho "$0" >> "$SCRATCH/ran"\n' > "$SCRATCH/build/Diplomat"

cat > "$SCRATCH/bin/launchctl" <<'EOF'
#!/bin/sh
echo "launchctl $*" >> "$SCRATCH/calls"
EOF
cat > "$SCRATCH/bin/pkill" <<'EOF'
#!/bin/sh
echo "pkill $*" >> "$SCRATCH/calls"
EOF
cat > "$SCRATCH/bin/pgrep" <<'EOF'
#!/bin/sh
echo "pgrep $*" >> "$SCRATCH/calls"
EOF
cat > "$SCRATCH/bin/open" <<'EOF'
#!/bin/sh
echo "open $*" >> "$SCRATCH/calls"
EOF
cat > "$SCRATCH/bin/swift" <<'EOF'
#!/bin/sh
echo "swift $*" >> "$SCRATCH/calls"
case "$*" in
  *--show-bin-path*) echo "$SCRATCH/build" ;;
  build*) git -C "$SCRATCH" -c user.name=installers -c user.email=installers@localhost \
            commit -q --allow-empty -m "during the compile" ;;
esac
EOF
cat > "$SCRATCH/bin/rm" <<'EOF'
#!/bin/sh
for a; do
  case "$a" in -*) continue ;; /*) p="$a" ;; *) p="$PWD/$a" ;; esac
  case "$p" in "$SCRATCH"/*) ;; *) echo "rm: $a: refused, outside the scratch dir" >&2; exit 1 ;; esac
done
exec /bin/rm "$@"
EOF
chmod +x "$SCRATCH"/bin/* "$SCRATCH/build/Diplomat"

run() { PATH="$SCRATCH/bin:$PATH" HOME="$SCRATCH/home" bash "$PKG/install/$1" "${@:2}" > "$SCRATCH/out" 2>&1; }
# Runs the agent at $1 as launchd would: its ProgramArguments. True when the binary they
# end with ran.
starts() {
  local args=() i=0 a
  while a="$(plutil -extract "ProgramArguments.$i" raw "$1" 2>/dev/null)"; do args+=("$a"); i=$((i + 1)); done
  [ "$i" -gt 0 ] || return 1
  /bin/rm -f "$SCRATCH/ran"
  "${args[@]}" > /dev/null 2>&1 || true
  grep -qxF "${args[$((i - 1))]}" "$SCRATCH/ran" 2>/dev/null
}
check() {   # $1 = what is proven, the rest = the command that proves it
  local name="$1"; shift
  if "$@"; then echo "  ok    $name"; return; fi
  echo "  FAIL  $name" >&2
  cat "$SCRATCH/out" "$SCRATCH/calls" >&2
  exit 1
}

echo "installers: what a login install writes"
check "install-autostart.sh runs to the end past a copy it cannot remove" run install-autostart.sh
check "…and says so" grep -q "delete it by hand" "$SCRATCH/out"
check "build-app.sh writes the bundle the agents name" test -x "$BIN"
check "…stamped with the commit it was compiled from" \
  test "$(plutil -extract DiplomatCommit raw "$PKG/Diplomat.app/Contents/Info.plist")" = "$COMPILED"
check "…with the native build system, which stamps the binary with its real SDK" \
  bash -c 'n=$(grep -c "^swift build " "$1"); [ "$n" -gt 0 ] && [ "$n" = "$(grep -c "^swift build .*--build-system native" "$1")" ]' \
  _ "$SCRATCH/calls"
check "the launcher the agents start is a link to /usr/bin/env" test "$(readlink "$LAUNCHER")" = /usr/bin/env
check "the login agent starts the bundle beside the package, through the launcher" \
  grep -qF "<string>$LAUNCHER</string><string>$BIN</string>" "$AGENTS/com.ignacy.diplomat.plist"
check "the login agent marks its start unattended, so it opens no window" \
  grep -qF "<key>DIPLOMAT_BACKGROUND</key><string>1</string>" "$AGENTS/com.ignacy.diplomat.plist"
check "…so the installer's own start, the operator's, opens the window once the app is up" \
  bash -c 'grep -A99 "bootstrap gui/[0-9]* .*/com.ignacy.diplomat.plist$" "$1" | grep -A99 "pgrep -xq Diplomat" | grep -qxF "open $2"' \
  _ "$SCRATCH/calls" "$PKG/Diplomat.app"
check "the bundle starts with no Dock tile, so a relaunch takes the kept-in-Dock one" \
  test "$(plutil -extract LSUIElement raw "$PKG/Diplomat.app/Contents/Info.plist")" = true
check "the auto-update agent runs that same bundle, through the launcher" \
  grep -qF "<string>$LAUNCHER</string><string>$BIN</string>" "$AGENTS/com.ignacy.diplomat.autoupdate.plist"
check "…in self-update mode" \
  grep -qF "<key>DIPLOMAT_SELF_UPDATE</key><string>1</string>" "$AGENTS/com.ignacy.diplomat.autoupdate.plist"
check "the watchdog agent runs that same bundle, through the launcher" \
  grep -qF "<string>$LAUNCHER</string><string>$BIN</string>" "$AGENTS/com.ignacy.diplomat.watchdog.plist"
check "…in watchdog mode" \
  grep -qF "<key>DIPLOMAT_WATCHDOG</key><string>1</string>" "$AGENTS/com.ignacy.diplomat.watchdog.plist"
for label in com.ignacy.diplomat com.ignacy.diplomat.autoupdate com.ignacy.diplomat.watchdog; do
  check "$label is loaded once written" \
    grep -qF "launchctl bootstrap gui/$(id -u) $AGENTS/$label.plist" "$SCRATCH/calls"
  check "…and starting it runs the bundle's binary" starts "$AGENTS/$label.plist"
done

echo "installers: the auto-update installer on its own"
/bin/rm -f "$AGENTS/com.ignacy.diplomat.autoupdate.plist"
check "install-autoupdate.sh runs with no argument" run install-autoupdate.sh
check "…and defaults to the bundle beside the package" \
  grep -qF "<string>$LAUNCHER</string><string>$BIN</string>" "$AGENTS/com.ignacy.diplomat.autoupdate.plist"

echo "installers: the watchdog installer on its own"
/bin/rm -f "$AGENTS/com.ignacy.diplomat.watchdog.plist"
check "install-watchdog.sh runs with no argument" run install-watchdog.sh
check "…and defaults to the bundle beside the package" \
  grep -qF "<string>$LAUNCHER</string><string>$BIN</string>" "$AGENTS/com.ignacy.diplomat.watchdog.plist"
OTHER="$SCRATCH/other/Diplomat.app/Contents/MacOS/Diplomat"
mkdir -p "$(dirname "$OTHER")" && cp "$SCRATCH/build/Diplomat" "$OTHER"
check "install-watchdog.sh runs with another checkout's bundle" run install-watchdog.sh "$OTHER"
check "…and starts it through the same launcher, as the app's rewrite does" \
  grep -qF "<string>$LAUNCHER</string><string>$OTHER</string>" "$AGENTS/com.ignacy.diplomat.watchdog.plist"
check "install-watchdog.sh runs with no argument again" run install-watchdog.sh

echo "installers: a checkout of a commit from before install/"
"${GIT[@]}" checkout -q "$BEFORE"
check "takes install/ away and leaves the bundle, as any checkout or revert can" \
  bash -c '[ ! -e "$1/install" ] && [ -x "$2" ]' _ "$PKG" "$BIN"
for label in com.ignacy.diplomat com.ignacy.diplomat.autoupdate com.ignacy.diplomat.watchdog; do
  check "$label still starts the binary" starts "$AGENTS/$label.plist"
done
"${GIT[@]}" checkout -q -

echo "installers: what the app's rewrite leaves alone is started directly"
ODD="$SCRATCH/a=b/Diplomat.app/Contents/MacOS/Diplomat"
mkdir -p "$(dirname "$ODD")" && cp "$SCRATCH/build/Diplomat" "$ODD"
only() { [ "$(plutil -extract ProgramArguments.0 raw "$1")" = "$2" ] && ! plutil -extract ProgramArguments.1 raw "$1" > /dev/null 2>&1; }
check "install-watchdog.sh runs with a bundle whose path holds =" run install-watchdog.sh "$ODD"
check "…and has the agent start it directly, as env would take it for a variable" \
  only "$AGENTS/com.ignacy.diplomat.watchdog.plist" "$ODD"
check "…which runs it" starts "$AGENTS/com.ignacy.diplomat.watchdog.plist"
check "install-watchdog.sh runs with a binary outside a bundle" run install-watchdog.sh "$SCRATCH/build/Diplomat"
check "…and has the agent start it directly" only "$AGENTS/com.ignacy.diplomat.watchdog.plist" "$SCRATCH/build/Diplomat"

echo "installers: whatever is where the launcher belongs"
for what in "a file" "a link to /bin/sh" "a directory"; do
  /bin/rm -rf "$LAUNCHER"
  case "$what" in
    "a file") printf /usr/bin/env > "$LAUNCHER" ;;
    "a link to /bin/sh") ln -s /bin/sh "$LAUNCHER" ;;
    "a directory") mkdir "$LAUNCHER" ;;
  esac
  check "install-watchdog.sh runs with $what there" run install-watchdog.sh
  check "…and puts the launcher in its place" test "$(readlink "$LAUNCHER")" = /usr/bin/env
done
/bin/rm -rf "$SCRATCH/home/Library/Application Support" "$AGENTS/com.ignacy.diplomat.watchdog.plist"
touch "$SCRATCH/home/Library/Application Support"
check "one that cannot be made fails install-watchdog.sh" eval '! run install-watchdog.sh'
check "…saying so" grep -q "Could not make .*the link to /usr/bin/env" "$SCRATCH/out"
check "…before it writes an agent that would start nothing" test ! -e "$AGENTS/com.ignacy.diplomat.watchdog.plist"
/bin/rm "$SCRATCH/home/Library/Application Support"
check "install-watchdog.sh runs again once it can be" run install-watchdog.sh

echo "installers: uninstall-autostart.sh"
/bin/rm -rf "$LAUNCHER" && mkdir "$LAUNCHER" && : > "$SCRATCH/calls"
check "runs, a directory where the launcher belongs" run uninstall-autostart.sh
check "…to the end, stopping the app" grep -qx "pkill -x Diplomat" "$SCRATCH/calls"
check "…and removes the agents and the launcher" \
  bash -c '[ ! -e "$1" ] && [ ! -L "$2" ] && [ ! -e "$(dirname "$2")" ]' _ "$AGENTS/com.ignacy.diplomat.plist" "$LAUNCHER"
echo "installers: all passed"
