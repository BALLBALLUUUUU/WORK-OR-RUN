#!/bin/bash
#
# 下班倒计时 —— 重新构建 OffWorkCountdown.app
#
# 用法：
#   ./build.sh            在已有 .app 上重建负载 / 图标 / Info.plist 并重新签名
#   ./build.sh --fresh    先删掉 .app，再从 /Applications/DeepSeek Harness.app 重新复制 Electron
#
# 环境变量：
#   ELECTRON_SRC   Electron 应用来源（默认 /Applications/DeepSeek Harness.app）
#   PYTHON         带 Pillow 的 Python（默认使用 DSH 自带运行时）
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
APP="$ROOT/OffWorkCountdown.app"
SRC_APP="${ELECTRON_SRC:-/Applications/DeepSeek Harness.app}"
RES="$APP/Contents/Resources"
PLIST="$APP/Contents/Info.plist"
PLISTBUDDY=/usr/libexec/PlistBuddy
PYTHON="${PYTHON:-$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3}"

if [ ! -x "$PYTHON" ]; then
  PYTHON="$(command -v python3 || true)"
fi

fresh=0
for arg in "$@"; do
  case "$arg" in
    --fresh) fresh=1 ;;
    -h|--help)
      sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "未知参数：$arg（可用：--fresh）" >&2
      exit 2
      ;;
  esac
done

# 安全兜底：目标路径必须位于本目录下
case "$APP" in
  "$ROOT"/*) ;;
  *)
    echo "拒绝操作意外路径：$APP" >&2
    exit 1
    ;;
esac

echo "==> 项目目录：$ROOT"

if [ "$fresh" = "1" ] && [ -d "$APP" ]; then
  echo "==> --fresh：删除旧的 $APP"
  rm -rf "$APP"
fi

if [ ! -d "$APP" ]; then
  if [ ! -d "$SRC_APP" ]; then
    echo "找不到 Electron 源应用：$SRC_APP" >&2
    echo "可以设置 ELECTRON_SRC 指向其他 Electron App，或先安装 Electron 后手动打包。" >&2
    exit 1
  fi
  echo "==> 从 $SRC_APP 复制 Electron 运行时（约 1 GB，请稍候）"
  ditto "$SRC_APP" "$APP"
fi

# ---------------------------------------------------------------------------
# 1) 图标
# ---------------------------------------------------------------------------
if [ -n "$PYTHON" ] && [ -x "$PYTHON" ]; then
  echo "==> 生成图标（Pillow）"
  "$PYTHON" "$ROOT/make-icons.py" "$ROOT/assets"
else
  echo "警告：找不到带 Pillow 的 python3，跳过图标生成（沿用现有图标）。" >&2
fi

if [ ! -f "$ROOT/assets/OffWorkCountdown.icns" ]; then
  echo "缺少 assets/OffWorkCountdown.icns，无法继续。" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 2) 替换 Electron 应用负载：Resources/app 优先于 app.asar 被 Electron 加载
# ---------------------------------------------------------------------------
echo "==> 替换应用负载"
rm -rf "$RES/app.asar" "$RES/app.asar.unpacked" "$RES/default_app.asar" "$RES/app"
rm -f "$RES/app-update.yml"
mkdir -p "$RES/app/assets"

for file in package.json main.js preload.js settings.html settings.js countdown.js; do
  if [ ! -f "$ROOT/$file" ]; then
    echo "缺少源文件：$ROOT/$file" >&2
    exit 1
  fi
  cp "$ROOT/$file" "$RES/app/$file"
done
for asset in \
  SunClockTemplate.png "SunClockTemplate@2x.png" \
  OvertimeTemplate.png "OvertimeTemplate@2x.png" \
  SunClockWork.png "SunClockWork@2x.png" \
  SunClockLunch.png "SunClockLunch@2x.png" \
  SunClockOvertime.png "SunClockOvertime@2x.png" \
  SunClockRest.png "SunClockRest@2x.png" \
  OvertimeCounting.png "OvertimeCounting@2x.png" \
  OvertimeIdle.png "OvertimeIdle@2x.png"; do
  if [ ! -f "$ROOT/assets/$asset" ]; then
    echo "缺少菜单栏图标资源：$ROOT/assets/$asset" >&2
    exit 1
  fi
  cp "$ROOT/assets/$asset" "$RES/app/assets/"
done
cp "$ROOT/assets/OffWorkCountdown.icns" "$RES/OffWorkCountdown.icns"
cp "$ROOT/assets/OffWorkCountdown.icns" "$RES/icon.icns"
cp "$ROOT/assets/icon-1024.png" "$RES/icon.png"

# ---------------------------------------------------------------------------
# 3) Info.plist：改身份、加 LSUIElement，保留 CFBundleName / CFBundleExecutable
# ---------------------------------------------------------------------------
echo "==> 更新 Info.plist"
if "$PLISTBUDDY" -c "Print :ElectronAsarIntegrity" "$PLIST" >/dev/null 2>&1; then
  "$PLISTBUDDY" -c "Delete :ElectronAsarIntegrity" "$PLIST"
fi
# 移除 dsh:// URL scheme 注册，避免和 DeepSeek Harness 抢协议
if "$PLISTBUDDY" -c "Print :CFBundleURLTypes" "$PLIST" >/dev/null 2>&1; then
  "$PLISTBUDDY" -c "Delete :CFBundleURLTypes" "$PLIST"
fi

set_plist() { # key type value
  local key="$1" type="$2" value="$3"
  if "$PLISTBUDDY" -c "Print :$key" "$PLIST" >/dev/null 2>&1; then
    "$PLISTBUDDY" -c "Set :$key $value" "$PLIST"
  else
    "$PLISTBUDDY" -c "Add :$key $type $value" "$PLIST"
  fi
}

set_plist CFBundleIdentifier string com.local.offworkcountdown
set_plist CFBundleDisplayName string 下班倒计时
set_plist CFBundleIconFile string OffWorkCountdown.icns
set_plist LSUIElement bool true
set_plist LSApplicationCategoryType string public.app-category.productivity
set_plist NSHumanReadableCopyright string "原创图标与代码，本地构建。"

VERSION="$(/usr/bin/sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -1)"
if [ -z "$VERSION" ]; then
  echo "无法从 package.json 读取 version。" >&2
  exit 1
fi
set_plist CFBundleShortVersionString string "$VERSION"
set_plist CFBundleVersion string "$VERSION"

/usr/bin/plutil -lint "$PLIST" >/dev/null
echo "    CFBundleName        = $("$PLISTBUDDY" -c "Print :CFBundleName" "$PLIST")"
echo "    CFBundleExecutable  = $("$PLISTBUDDY" -c "Print :CFBundleExecutable" "$PLIST")"
echo "    CFBundleIdentifier  = $("$PLISTBUDDY" -c "Print :CFBundleIdentifier" "$PLIST")"
echo "    CFBundleDisplayName = $("$PLISTBUDDY" -c "Print :CFBundleDisplayName" "$PLIST")"
echo "    CFBundleVersion     = $("$PLISTBUDDY" -c "Print :CFBundleVersion" "$PLIST")"
echo "    LSUIElement         = $("$PLISTBUDDY" -c "Print :LSUIElement" "$PLIST")"

# ---------------------------------------------------------------------------
# 4) Ad-hoc 签名（不使用 hardened runtime）
# ---------------------------------------------------------------------------
echo "==> Ad-hoc 签名"
/usr/bin/xattr -cr "$APP" || true
rm -rf "$APP/Contents/_CodeSignature"
/usr/bin/codesign --force --deep --sign - "$APP"

echo "==> 校验签名"
/usr/bin/codesign --verify --deep --strict --verbose=2 "$APP"
/usr/bin/codesign -dv --verbose=2 "$APP" 2>&1 | sed -n '1,12p'

echo
echo "构建完成：$APP"
echo "启动：open \"$APP\""
echo "源码：$ROOT/{package.json,main.js,preload.js,settings.html,settings.js,countdown.js}"
echo "设置：~/Library/Application Support/OffWorkCountdown/settings.json"
