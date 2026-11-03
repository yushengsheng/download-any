#!/bin/sh
SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd) || exit 1
# Finder has a minimal PATH; discover common Node installations without a username/version.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  USER_HOME=$(eval "printf '%s' ~$(id -un 2>/dev/null)" 2>/dev/null || printf '%s' "$HOME")
  for home_dir in "$HOME" "$USER_HOME"; do
    for candidate in "$home_dir"/.volta/bin/node "$home_dir"/.nvm/versions/node/*/bin/node "$home_dir"/.local/share/pi-node/*/bin/node "$home_dir"/.local/share/fnm/node-versions/*/installation/bin/node "$home_dir"/.asdf/shims/node; do
      if [ -x "$candidate" ] && [ "$("$candidate" -p 'Number(process.versions.node.split(".")[0]) >= 20' 2>/dev/null)" = "true" ]; then
        node_bin=$(dirname -- "$candidate") || exit 1
        export PATH="$node_bin:$PATH"
        break 2
      fi
    done
  done
fi
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' '请先安装 Node.js 20 或更新的 LTS 版本：https://nodejs.org/' >&2
  exit 1
fi
exec node "$SCRIPT_DIR/start.js" "$@"
