#!/bin/sh
SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd) || exit 1
/bin/sh "$SCRIPT_DIR/launch.sh" "$@"
result=$?
if [ "$result" -ne 0 ]; then
  printf '%s' '启动失败，按回车退出…'
  read -r _answer
fi
exit "$result"
