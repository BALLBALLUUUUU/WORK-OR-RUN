#!/bin/bash
#
# 下班倒计时（WORK OR RUN）—— 构建 App + 打包 DMG + GitHub Release 辅助脚本
#
# 用法：
#   ./release.sh                构建 .app（调用 build.sh）并打包 DMG
#   ./release.sh --skip-build   跳过构建，直接用现有 .app 打包
#   ./release.sh --publish      打包后若检测到 gh CLI，直接创建 GitHub Release
#
# 说明：
#   - 本脚本需要普通终端环境（hdiutil / codesign / gh 在 DSH 沙箱里可能不可用）。
#   - 不会自动修改版本号；发版前请先按 README「发布到 GitHub」提升版本。
#   - DMG 输出到 dist/OffWorkCountdown-<version>-arm64.dmg（附 .sha256）。
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
APP="$ROOT/OffWorkCountdown.app"
DIST="$ROOT/dist"
PLIST="$APP/Contents/Info.plist"
PLISTBUDDY=/usr/libexec/PlistBuddy

skip_build=0
publish=0
for arg in "$@"; do
  case "$arg" in
    --skip-build) skip_build=1 ;;
    --publish) publish=1 ;;
    -h|--help)
      /usr/bin/sed -n '2,16p' "$0" | /usr/bin/sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "未知参数：$arg（可用：--skip-build / --publish）" >&2
      exit 2
      ;;
  esac
done

# 安全兜底：目标必须是本目录下的 App
case "$APP" in
  "$ROOT"/*) ;;
  *)
    echo "拒绝操作意外路径：$APP" >&2
    exit 1
    ;;
esac

VERSION="$(/usr/bin/sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -1)"
if [ -z "$VERSION" ]; then
  echo "无法从 package.json 读取 version。" >&2
  exit 1
fi
TAG="v$VERSION"
DMG="$DIST/OffWorkCountdown-$VERSION-arm64.dmg"

echo "==> 版本：$VERSION（tag $TAG）"

if [ "$skip_build" = "0" ]; then
  "$ROOT/build.sh"
else
  echo "==> --skip-build：跳过 build.sh"
fi

if [ ! -d "$APP" ]; then
  echo "找不到 $APP，请先运行 ./build.sh。" >&2
  exit 1
fi

APP_VERSION="$("$PLISTBUDDY" -c 'Print :CFBundleShortVersionString' "$PLIST")"
if [ "$APP_VERSION" != "$VERSION" ]; then
  echo "版本不一致：package.json=$VERSION，App=$APP_VERSION" >&2
  echo "请重新运行 ./build.sh 后再打包。" >&2
  exit 1
fi

if ! /usr/bin/codesign --verify --deep --strict "$APP" >/dev/null 2>&1; then
  echo "签名校验失败，请先重新构建。" >&2
  exit 1
fi

echo "==> 准备 DMG 内容"
STAGING="$(/usr/bin/mktemp -d /tmp/offwork-dmg.XXXXXX)"
cleanup() {
  case "$STAGING" in
    /tmp/offwork-dmg.*) /bin/rm -rf "$STAGING" ;;
    *) echo "跳过清理意外路径：$STAGING" >&2 ;;
  esac
}
trap cleanup EXIT

/usr/bin/ditto "$APP" "$STAGING/OffWorkCountdown.app"
/bin/ln -s /Applications "$STAGING/Applications"
cat > "$STAGING/安装说明.txt" <<'EOF'
下班倒计时（WORK OR RUN）
=======================

安装：
1. 把 OffWorkCountdown.app 拖到 Applications（应用程序）文件夹。
2. 首次打开若提示“无法验证开发者”，右键图标 →「打开」，
   或执行：xattr -dr com.apple.quarantine /Applications/OffWorkCountdown.app

说明：
- 本 App 为 ad-hoc 签名、未做苹果公证，属正常现象。
- 仅支持 Apple Silicon（arm64）Mac，macOS 11+。
- 用户数据保存在 ~/Library/Application Support/OffWorkCountdown/，
  卸载或重装 App 不会丢失（需要恢复默认就删掉该目录）。
- 首次启动或版本升级后会自动打开一次设置窗口。
EOF

/bin/mkdir -p "$DIST"
echo "==> 打包 DMG：$DMG"
/usr/bin/hdiutil create \
  -volname "下班倒计时" \
  -srcfolder "$STAGING" \
  -ov -format UDZO \
  "$DMG"

echo "==> 校验 DMG"
/usr/bin/hdiutil verify "$DMG"
/usr/bin/shasum -a 256 "$DMG" | /usr/bin/tee "$DMG.sha256"

echo
echo "DMG 完成：$DMG"
echo "SHA-256：$(/usr/bin/awk '{print $1}' "$DMG.sha256")"
echo

if command -v gh >/dev/null 2>&1; then
  echo "检测到 gh CLI。"
  if [ "$publish" = "1" ]; then
    echo "==> gh release create $TAG"
    gh release create "$TAG" "$DMG" \
      --title "下班倒计时 $TAG" \
      --notes "下班倒计时 $TAG：喝水/休息提醒、标签式设置窗口、主题与高亮色、GitHub 更新检查。"
    echo "已创建 Release：https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo '<owner>/<repo>')/releases/tag/$TAG"
    exit 0
  fi
  echo "如需直接发布，可运行："
  echo "  ./release.sh --publish --skip-build"
  echo "或手动执行："
  echo "  gh release create $TAG \"$DMG\" --title \"下班倒计时 $TAG\" --notes \"发布说明\""
  exit 0
fi

echo "未检测到 gh CLI，请手动在 GitHub 创建 Release："
echo "  1. 打开仓库 → Releases → Draft a new release"
echo "  2. Tag 填：$TAG（例如 $TAG）"
echo "  3. 标题可填：下班倒计时 $TAG"
echo "  4. 上传文件：$DMG"
echo "  5. 点击 Publish release"
echo
echo "安装 gh 后可自动化："
echo "  brew install gh && gh auth login"
echo "  ./release.sh --publish --skip-build"
echo
echo "注意：App 内「更新源」必须指向同一个仓库（owner/repo），"
echo "「检测更新」会读取 /releases/latest 的 tag_name 与当前版本比较。"
