#!/usr/bin/env bash
# 一键打包：交互选 1=macOS / 2=Windows（也支持 ./package.sh 1 直选，免交互）
# Windows 在 macOS 上走交叉打包；Electron 二进制走 npmmirror，避免直连不稳
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="codex-token-statusbar"
APP_BUNDLE="$APP_NAME.app"
WIN_DIR="$APP_NAME-win64"
WIN_ZIP="$APP_NAME-win64.zip"
DIST="dist"

if [ ! -x "node_modules/.bin/electron-builder" ]; then
  npm ci
fi

choice="${1:-}"
if [ -z "$choice" ]; then
  echo "请选择打包目标："
  echo "  1) macOS（.app）"
  echo "  2) Windows（win-unpacked + 分发 zip）"
  read -r -p "输入 1 或 2: " choice
fi

export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"

case "$choice" in
  1)
    echo "==> 打包 macOS..."
    if [ -e "$APP_BUNDLE" ]; then
      rm -rf "$APP_BUNDLE"
    fi
    rm -rf "$DIST"
    ./node_modules/.bin/electron-builder --mac --arm64 --dir
    if [ ! -d "$DIST/mac-arm64/$APP_BUNDLE" ]; then
      echo "打包失败：未找到 $DIST/mac-arm64/$APP_BUNDLE" >&2
      exit 1
    fi
    mv "$DIST/mac-arm64/$APP_BUNDLE" "$APP_BUNDLE"
    codesign --force --deep --sign - "$APP_BUNDLE"
    rm -rf "$DIST"
    echo "==> 完成，产物："
    echo "    $APP_BUNDLE"
    ;;
  2)
    echo "==> 打包 Windows..."
    if [ -e "$WIN_DIR" ]; then
      rm -rf "$WIN_DIR"
    fi
    if [ -e "$WIN_ZIP" ]; then
      rm -rf "$WIN_ZIP"
    fi
    rm -rf "$DIST"
    ./node_modules/.bin/electron-builder --win --x64 --dir
    if [ ! -d "$DIST/win-unpacked" ]; then
      echo "打包失败：未找到 $DIST/win-unpacked" >&2
      exit 1
    fi
    mv "$DIST/win-unpacked" "$WIN_DIR"
    ditto -c -k --sequesterRsrc "$WIN_DIR" "$WIN_ZIP"
    rm -rf "$DIST"
    echo "==> 完成，产物："
    echo "    $WIN_DIR"
    echo "    $WIN_ZIP"
    ;;
  *)
    echo "无效选择: ${choice}（仅支持 1 或 2）" >&2
    exit 1
    ;;
esac
