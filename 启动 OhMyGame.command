#!/bin/zsh -f
set -eu
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
PROJECT_DIR="$(CDPATH= cd -- "$(/usr/bin/dirname -- "$0")" && pwd -P)"
NODE="$PROJECT_DIR/.runtime/toolchain/node/bin/node"
if [[ ! -x "$NODE" ]]; then
  print -r -- '项目专用 Node 尚未准备；不会使用全局 Node 或自动下载。请查看 docs/manual-acceptance.md。'
  exit 1
fi
NODE_SUM="$(/usr/bin/env -i PATH=/usr/bin:/bin /usr/bin/shasum -a 256 "$NODE")"
if [[ "${NODE_SUM%% *}" != '2cc28a1880d0774616959f2210ee739bffa6ac695c887e8988a496a21271f6c0' ]]; then
  print -r -- '项目 Node 校验不符，已停止，未执行该运行时。'
  exit 1
fi
exec /usr/bin/env -i HOME="$PROJECT_DIR/.runtime/local-launch/home" TMPDIR="$PROJECT_DIR/.runtime/local-launch/tmp" PATH="$PROJECT_DIR/.runtime/toolchain/node/bin:/usr/bin:/bin:/usr/sbin:/sbin" LANG=zh_CN.UTF-8 "$NODE" "$PROJECT_DIR/scripts/local-launch.mjs"
