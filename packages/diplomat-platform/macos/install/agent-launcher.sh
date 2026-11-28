# Sourced by the agents' installers; Daemon.rewriteOntoLauncher applies the same rule.
#
# agent_program <binary> prints the ProgramArguments items an agent starts <binary> with.
# A bundle's binary is started through LAUNCHER, a link to /usr/bin/env made here: macOS
# kills an agent loaded at login whose program's signature has changed since, every build
# re-signs Diplomat, and env's signature never changes. The link is outside every checkout,
# so no checkout or revert takes it from the agents, and Login Items lists them by its
# name. A path holding `=` is started directly, as env would take it for a variable.
LAUNCHER="$HOME/Library/Application Support/Diplomat/Diplomat"

agent_program() {
  case "$1" in
    *=*) ;;
    */Contents/MacOS/Diplomat)
      mkdir -p "$(dirname "$LAUNCHER")" && rm -rf "$LAUNCHER" && ln -s /usr/bin/env "$LAUNCHER" \
        || { echo "Could not make $LAUNCHER, the link to /usr/bin/env the agents start." >&2; return 1; }
      printf '<string>%s</string>' "$LAUNCHER" ;;
  esac
  printf '<string>%s</string>' "$1"
}
