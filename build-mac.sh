#!/usr/bin/env bash
# 打包 codex-token-statusbar.app，并把产物移动到当前源码目录
# 用法：cd codex-statusbar-overlay && ./build-mac.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="codex-token-statusbar.app"
BUILD_DIR="$SCRIPT_DIR/dist"
BUILT_APP="$BUILD_DIR/mac-arm64/$APP_NAME"
FINAL_APP="$SCRIPT_DIR/$APP_NAME"

cd "$SCRIPT_DIR"

# 依赖缺失时先安装；package-lock 已锁定 electron 44.4.3，保持打包版本稳定
if [ ! -x "$SCRIPT_DIR/node_modules/.bin/electron-builder" ]; then
  npm ci
fi

# 清理旧产物，避免新旧文件混在一起
if [ -e "$FINAL_APP" ]; then
  rm -rf "$FINAL_APP"
fi
rm -rf "$BUILD_DIR"

# 按 package.json 的 build 配置打出 arm64 目录应用
./node_modules/.bin/electron-builder --dir --arm64

if [ ! -d "$BUILT_APP" ]; then
  echo "打包失败：未找到 $BUILT_APP" >&2
  exit 1
fi

# 把应用移动到源码目录，便于直接运行和分发
mv "$BUILT_APP" "$FINAL_APP"
rm -rf "$BUILD_DIR"

# ad-hoc 重签，保证本机可直接打开
codesign --force --deep --sign - "$FINAL_APP"

echo "已打包到：$FINAL_APP"
