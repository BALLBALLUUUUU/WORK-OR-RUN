# WORK OR RUN · 下班倒计时 — GitHub 上传与发布说明

**本项目实际仓库**：<https://github.com/BALLBALLUUUUU/WORK-OR-RUN>（公开），
App 默认更新源已设为 `BALLBALLUUUUU/WORK-OR-RUN`。

本文档从头到尾说明如何把本项目上传到 GitHub，并发出第一个可被 App「检测更新」识别到的 Release。

> 适用对象：本项目的维护者（黄溢球）。
> 项目目录：`mac-app/`。App 名：**WORK OR RUN · 下班倒计时**，当前版本 **v1.4.0**。
> 本文所有命令都在 `mac-app/` 目录下执行（`cd mac-app` 之后）。

---

## 0. 先明确两个概念

| 内容 | 放在哪里 | 是否进 Git 仓库 |
| --- | --- | --- |
| 源码（js / html / py / sh / md / assets 小图标） | GitHub 仓库 | ✅ 是 |
| `OffWorkCountdown.app`（约 599 MB 构建产物） | 本机 / 用户安装 | ❌ 否（`.gitignore` 已排除） |
| `dist/*.dmg`（约 261 MB 安装包） | GitHub **Releases** 附件 | ❌ 否（`.gitignore` 已排除） |
| 用户数据 `~/Library/Application Support/OffWorkCountdown/` | 用户本机 | ❌ 否 |

GitHub 仓库只放源码，DMG 作为 Release 附件分发。仓库保持几百 KB 级别。

---

## 1. 准备工作

### 1.1 工具检查

```bash
git --version                    # 本机已安装：git 2.54
node --version                   # 用于跑单测（可选）
```

如果没有 git：安装 Xcode Command Line Tools（`xcode-select --install`）或使用 GitHub Desktop。

### 1.2 首次使用 git 需要配置身份（只做一次）

```bash
git config --global user.name "黄溢球"
git config --global user.email "你的邮箱@example.com"
```

### 1.3 认证方式（三选一）

**A. HTTPS + Personal Access Token（最简单）**

1. GitHub → 右上角头像 → Settings → Developer settings → Personal access tokens
   → Tokens (classic) → Generate new token；
2. 勾选 `repo` 权限（fine-grained token 则选目标仓库 + Contents 读写）；
3. 复制 token；`git push` 提示 Password 时粘贴 token（不是 GitHub 登录密码）。

**B. SSH（推荐长期使用）**

```bash
ssh-keygen -t ed25519 -C "你的邮箱@example.com"     # 一路回车即可
pbcopy < ~/.ssh/id_ed25519.pub                       # 复制公钥
# 粘贴到 GitHub → Settings → SSH and GPG keys → New SSH key
ssh -T git@github.com                                # 看到 successfully authenticated 即可
```

**C. GitHub CLI（可自动化发版）**

```bash
gh auth login          # 按提示登录
gh repo create <owner>/<repo> --public --source=. --push
```

> 未安装 gh 也可以，本文的手动流程无需它。

---

## 2. 创建 GitHub 仓库

1. 打开 <https://github.com/new>；
2. **Repository name**：例如 `work-or-run`（与 App 内「更新源」一致）；
3. 可见性：**Public**（推荐；「检测更新」用的是匿名 GitHub API，私有仓库会 404）；
4. **不要**勾选 “Add a README file / .gitignore / license”（保持空仓库，减少第一次推送冲突）；
5. 点击 **Create repository**。

创建后页面会给出仓库地址，例如：

```
https://github.com/<owner>/work-or-run.git
git@github.com:<owner>/work-or-run.git
```

---

## 3. 本地初始化并推送

```bash
cd mac-app          # 进入项目目录
git init
git add .
git status         # ★ 检查：不应出现 OffWorkCountdown.app/ 或 dist/*.dmg
git commit -m "WORK OR RUN v1.4.0: macOS menu-bar countdown with reminders"
git branch -M main

# HTTPS 方式（<owner> 换成你的用户名/组织名）
git remote add origin https://github.com/<owner>/work-or-run.git
# 或 SSH 方式：
# git remote add origin git@github.com:<owner>/work-or-run.git

git push -u origin main
```

### 3.1 `.gitignore` 已包含

项目里的 `.gitignore` 已排除构建产物与大文件，正常情况下 `git status` 只会看到源码：

```
OffWorkCountdown.app/      # 599 MB 构建产物
dist/*.dmg
dist/*.dmg.sha256
.DS_Store
__pycache__/
*.pyc
*.log
```

### 3.2 推送后检查

- 打开 `https://github.com/<owner>/work-or-run`，应能看到 `main.js`、`README.md`、`assets/` 等；
- 仓库大小应是几百 KB～几 MB，**不应出现 599 MB 的 App**；
- 如果 `git status` 里误加了 App/DMG，先撤出暂存：

```bash
git rm -r --cached OffWorkCountdown.app
git rm --cached dist/*.dmg 2>/dev/null || true
git commit -m "chore: drop build artifacts from git"
```

### 3.3 如果仓库初始化时带了 README（非空仓库）

```bash
git pull --rebase origin main
git push -u origin main
```

---

## 4. 发布第一个 Release（v1.4.0）

> 发布前确认 App 版本号已同步：`package.json`、`main.js` 自检断言、`settings.html`
> 静态版本占位、`README.md`（见第 6 节）。

### 4.1 在本机构建并生成 DMG

构建需要本机有一套 Electron 运行时来源（默认 `/Applications/DeepSeek Harness.app`，
可用环境变量 `ELECTRON_SRC` 指定另一个 Electron App），以及 hdiutil / codesign。
本机已具备，直接在**普通终端**（不是在受限的沙盒终端里）执行：

```bash
cd mac-app
./release.sh                 # 调 build.sh 重建 App，并打包 DMG + 生成 .sha256
# 或者：已有签名好的 .app，跳过构建：
./release.sh --skip-build
```

产物：

```
dist/OffWorkCountdown-1.4.0-arm64.dmg
dist/OffWorkCountdown-1.4.0-arm64.dmg.sha256
```

> 本次已生成好的 DMG（可直接用）：
> `dist/OffWorkCountdown-1.4.0-arm64.dmg`，
> SHA-256 `118d347aa7c2085027463b50a5ba9d921fcb4a8e119b36dfc5ca80cc27cd83f2`。

### 4.2 创建 Release（网页方式）

1. 仓库页 → **Releases** → **Draft a new release**；
2. **Choose a tag** → 输入 `v1.4.0` → **Create new tag: v1.4.0 on publish**（tag 必须与版本对应，可带 `v` 前缀）；
3. **Release title**：`WORK OR RUN v1.4.0`；
4. **Describe this release**：粘贴 `dist/RELEASE_NOTES-v1.4.0.md` 的内容（或自行精简）；
5. 拖入两个附件：
   - `dist/OffWorkCountdown-1.4.0-arm64.dmg`
   - `dist/OffWorkCountdown-1.4.0-arm64.dmg.sha256`
6. 点击 **Publish release**。

> ⚠️ 必须是 **Publish** 后的正式 Release；**Draft（草稿）和 Pre-release（预发布）不会被
> App 的「检测更新」看到**，因为 App 读取的是 `/releases/latest`。

### 4.3 创建 Release（gh CLI 方式，可选）

```bash
gh auth login
gh release create v1.4.0 \
  "dist/OffWorkCountdown-1.4.0-arm64.dmg" \
  "dist/OffWorkCountdown-1.4.0-arm64.dmg.sha256" \
  --title "WORK OR RUN v1.4.0" \
  --notes-file dist/RELEASE_NOTES-v1.4.0.md
```

或使用项目脚本自动完成：

```bash
./release.sh --publish          # 构建 + DMG + gh release create
./release.sh --publish --skip-build   # 已有 DMG 时直接发
```

### 4.4 验证 Release 可以被 API 读取

```bash
curl -s https://api.github.com/repos/<owner>/work-or-run/releases/latest \
  | grep -E '"tag_name"|"html_url"'
```

应返回类似：

```
"html_url": "https://github.com/<owner>/work-or-run/releases/tag/v1.4.0"
"tag_name": "v1.4.0"
```

---

## 5. 让 App 的「检测更新」指向你的仓库

App 默认更新源已设为 `BALLBALLUUUUU/WORK-OR-RUN`。如需指向别的仓库，两种方式：

**方式 A（推荐，无需重新构建）**：打开 App 菜单栏 →「设置…」→ 标签页 **设置** →
**更新源** 填 `owner/repo`（当前为 `BALLBALLUUUUU/WORK-OR-RUN`）→ 保存。
之后点「设置」底部或「关于」页的 **检测更新**。

**方式 B（改默认值，适合分发给其他人）**：编辑 `countdown.js` 第 308 行附近：

```js
const DEFAULT_UPDATE_REPO = 'BALLBALLUUUUU/WORK-OR-RUN';
// 改成：const DEFAULT_UPDATE_REPO = '<owner>/<repo>';
```

然后重新 `./build.sh` + 重新打包 DMG 并发布。这样新安装的用户开箱即用。

> 检测更新只在用户点击时请求 GitHub API，不会自动联网；
> 它只比较版本并给链接，**不下载、不自动安装**。用户从 Release 页下载 DMG 覆盖安装即可。

---

## 6. 以后发新版本（流程清单）

1. 修改版本号（四处都要同步，否则自检/关于页会不一致）：
   - `package.json` → `"version": "1.5.0"`（`build.sh` 会写进 Info.plist）
   - `main.js` 自检里的版本断言
   - `settings.html` 的 `settingsVersion` / `metaVersion` 静态占位
   - `README.md` 的版本号与变更说明
2. 运行测试与构建：

   ```bash
   node test-countdown.js
   ./build.sh
   ```

3. 打包并检查 DMG：

   ```bash
   ./release.sh --skip-build
   ```

4. 提交源码并打 tag：

   ```bash
   git add -A
   git commit -m "release v1.5.0"
   git tag v1.5.0
   git push origin main --tags
   ```

5. 在 GitHub 创建新的 Release（tag `v1.5.0`），上传新 DMG 和 `.sha256`，粘贴新的发布说明；
6. 老用户点「检测更新」就会看到「发现新版本 v1.5.0」和下载链接。

---

## 7. 常见问题

| 问题 | 原因 / 解决 |
| --- | --- |
| `git push` 提示 `non-fast-forward` | 仓库非空（建库时勾了 README）：`git pull --rebase origin main` 后再 push |
| 仓库变大 / 推送很慢 | 把 `OffWorkCountdown.app/` 或 `dist/*.dmg` 提交了：`git rm -r --cached` 后重新提交；已有历史可用 `git filter-repo` 清理 |
| 「检测更新」提示 404 | ① 更新源 owner/repo 写错；② 仓库里还没有**正式 Release**；③ 仓库是私有的（匿名 API 看不到）。先用第 4.4 节 curl 验证 |
| 「检测更新」提示 403 | GitHub 匿名 API 限流（每 IP 每小时 60 次），稍后再试 |
| 显示“已是最新版本”但明明发了新版 | 新 Release 的 tag 必须 **比当前版本大**（如 v1.5.0），且是 Publish 后的正式版；Draft/Pre-release 不算 |
| 换台 Mac 打开提示“无法验证开发者” | 本 App 为 ad-hoc 签名、未公证：右键图标 →「打开」，或 `xattr -dr com.apple.quarantine /Applications/OffWorkCountdown.app` |
| Intel Mac 打不开 | 当前只构建了 Apple Silicon（arm64）版本，需要另建 x64 构建 |
| 构建报错找不到 Electron | `build.sh` 默认从 `/Applications/DeepSeek Harness.app` 复制 Electron 运行时；用 `ELECTRON_SRC=/path/to/SomeElectron.app ./build.sh` 指定 |
| 安装到 /Applications 后开机启动不生效 | 在菜单里重新勾选一次「开机启动」，让登录项指向新路径 |

---

## 8. 发布前安全检查清单

- [ ] `git status` 中没有 `OffWorkCountdown.app/`、`dist/*.dmg`、`.DS_Store`、`__pycache__/`
- [ ] 仓库中没有用户数据（`settings.json`、`water-state.json`、`*.log` 不会出现在项目目录，但提交前仍应确认）
- [ ] `package.json` 版本、App 版本、Release tag 三者一致（本例：1.4.0 / 1.4.0 / v1.4.0）
- [ ] `node test-countdown.js` 全绿
- [ ] `./build.sh` 成功且 `codesign --verify --deep --strict OffWorkCountdown.app` 通过
- [ ] DMG 已用 `hdiutil verify` 校验，并生成 `.sha256`
- [ ] GitHub Release 已 **Publish**（不是 Draft / Pre-release）
- [ ] 用 curl 确认 `/releases/latest` 的 `tag_name` 正确
- [ ] App 内「检测更新」能显示“已是最新版本”或“发现新版本”
- [ ] 在另一台 Mac 上从 Release 下载 DMG，按「安装说明.txt」安装验证一次

---

## 9. 附：本项目常用路径速查

| 用途 | 路径 |
| --- | --- |
| 项目源码 | `mac-app/` |
| 构建脚本 | `mac-app/build.sh` |
| 一键构建 + 打包 DMG | `mac-app/release.sh` |
| DMG 产物 | `mac-app/dist/OffWorkCountdown-<version>-arm64.dmg` |
| 发布说明模板 | `mac-app/dist/RELEASE_NOTES-v1.4.0.md` |
| 用户数据（不提交） | `~/Library/Application Support/OffWorkCountdown/` |
| 更新源常量 | `mac-app/countdown.js` 的 `DEFAULT_UPDATE_REPO` |
