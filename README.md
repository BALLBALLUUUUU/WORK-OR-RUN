# 下班倒计时（OffWorkCountdown / WORK OR RUN）

一个常驻 macOS 菜单栏的下班倒计时小工具：菜单栏直接显示「距下班 07:31:42」，
支持双休 / 单休 / 大小休 / 按月四周 / 自定义休息日、午休状态、下班前提醒、
加班计时，以及 v1.4.0 新增的喝水提醒、休息提醒、标签式设置窗口、主题/高亮色
和 GitHub Release 更新检查。纯本地运行，无第三方运行时依赖；只有「检测更新」
会访问 GitHub API。

- 版本：**1.4.0**
- 应用包：`mac-app/OffWorkCountdown.app`（可双击启动）
- 设置窗口标题：**WORK OR RUN**
- 界面语言：简体中文
- 适用系统：macOS 11+（本机在 macOS 27.2 / arm64 上构建并验证）

v1.4.0 主要变化：

- 设置窗口改为 **五个标签页**（倒计时 / 喝水提醒 / 休息提醒 / 设置 / 关于），
  窗口 640×760（按屏幕收敛），标题固定为 `WORK OR RUN`；
- 新增 **喝水提醒**：间隔提醒、每日目标、每次记录、进度条与今日记录；
- 新增 **休息提醒**：间隔提醒 + 每次休息时长；
- 新增 **高亮颜色**（预设 + 自定义）与 **主题模式**（跟随系统 / 跟随日出日落 /
  浅色 / 深色），设置窗口完整支持浅色/深色；
- 新增 **GitHub Release 更新检查**（`检测更新` 按钮，纯比较语义化版本）；
- 首次安装或版本变化后 **自动打开一次设置窗口**（`lastSeenVersion`）；
- **P1 图标修正**：午休绿色图标（以及全部「半轮落日」状态图标）重新居中、
  加大视觉重量，alpha bbox 中心与画布中心偏差 0.00px（16/32px）。

---

## 功能

### 菜单栏状态

每秒刷新，数字使用等宽字体（`monospacedDigit`），不会左右跳动。

| 场景 | 菜单栏标题 | 菜单头部 |
| --- | --- | --- |
| 工作日、上班前/上班中 | `距下班 HH:MM:SS` | `距下班 HH:MM:SS（10:00–19:00）` |
| 工作日、午休时间内 | `午休中 HH:MM:SS` | `午休中 · 距下午上班 HH:MM:SS` |
| 工作日、下班后 | `已下班` | `已下班 · 19:00 后好好休息` |
| 休息日（周六/周日） | `周末愉快` | `周末愉快 · 今天不用上班` |
| 休息日（自定义的工作日） | `今天休息` | `今天休息 · 不用上班` |

- 休息日不参与倒计时，`remainingMs = 0`、`workRemainingMs = 0`。
- 午休只改变菜单栏展示的倒计时目标（到下午上班），**不影响**绝对下班时间，
  也不影响下班/提前通知的剩余时间计算。
- 午休结束的瞬间（如 13:00:00）立即恢复「距下班」；若午休窗口跨过下班时间，
  下班状态优先显示「已下班」。

### 菜单栏图标颜色

两个 Tray 的**前导图标**会跟随当前状态换色，右侧文字/标题保持原样。
彩色变体全部是**非模板图**（`template=false`，透明背景），因此系统不会把它们
强制染成单色；原有黑色模板图仍保留，仅作为彩色资源异常时的兜底。

| 状态 | 判定 | 主倒计时图标 | 加班托盘图标 |
| --- | --- | --- | --- |
| `work` 工作 | 工作日，不在午休、未到加班起算 | 浅橙 `#F5A65B` | — |
| `lunch` 午休 | 工作日，`lunch.start <= now < lunch.end` | 浅绿 `#8FD19E` | — |
| `overtime` 加班 | 工作日，`overtime.enabled` 且 `now >= overtime.start` | 红 `#E5533D` | 红 `#E5533D`（计时中） |
| `rest` 休息 | 今天按当前 `restMode` 是休息日 | 灰蓝 `#9AA4B2` | 灰蓝 `#9AA4B2`（空闲） |
| 下班后、加班前 | 工作日，已过 `workEnd` 但未到 `overtime.start` | 浅橙 `#F5A65B` | — |
| 加班关闭 | `overtime.enabled=false` | 按主状态（work/lunch/rest） | 托盘隐藏 |

- 主图标冲突优先级：`rest > overtime > lunch > work`。
- 边界约定：午休开始**含**、结束**不含**；加班起算**含**。
- 图标只在状态变化时调用 `tray.setImage()`；`nativeImage` 按状态缓存。
  日志会记录切换：`tray icon state=work color=#F5A65B`。
- 若彩色 PNG 缺失或 Electron/Tray 拒绝彩色图，会回退到模板图并记录
  `fallback=template`。

**P1：午休图标居中（v1.4.0）**

原「半轮落日」几何偏下，alpha bbox 中心在 16px 画布上约为 `(7.5, 10.5)`，
视觉上下沉且偏小。v1.4.0 重新绘制（太阳半轮更高、地平线上移），全部主状态图标
共用新几何，`make-icons.py --verify` 会计算每个 PNG 的 alpha bbox：

| 文件 | 尺寸 | bbox | bbox 中心 | 偏移 | 笔画质量 | 质量比（对月牙） | 最大跨度比 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `SunClockLunch.png` | 16×16 | (1,4)–(14,11) | (7.50, 7.50) | (+0.00, +0.00) | 62 px | 1.11 | 1.17 |
| `SunClockLunch@2x.png` | 32×32 | (2,8)–(29,23) | (15.50, 15.50) | (+0.00, +0.00) | 242 px | 1.12 | 1.17 |
| `SunClockWork/Overtime/Rest` | 16/32 | 同上 | 同上 | 0.00px | 同上 | 同上 | 同上 |

`make-icons.py --verify`（以及 `./build.sh` 内的图标生成）会强制断言：

- 所有主状态图标（work/lunch/overtime/rest + 模板）alpha bbox 中心与画布中心
  偏差 ≤ **1px**；
- 笔画质量（alpha ≥ 128 的像素数）相对「月牙」参考图标在 **0.6–1.6** 倍；
- 最大跨度相对参考图标在 **0.8–1.35** 倍。

### 加班计时（第二个菜单栏项目）

开启加班计时后，会在倒计时项目旁**再创建一个独立的 Tray**，使用原创的
「月牙 + 星点」图标（计时中红色 `#E5533D`，空闲灰蓝 `#9AA4B2`），每秒刷新：

| 场景 | 加班菜单栏标题 |
| --- | --- |
| 工作日且 `now >= overtime.start` | `加班时长:HH:MM:SS`（从当天起算时刻累计） |
| 起算前 / 休息日 / 已关闭 | `暂无加班` |

- 只按「当天」计算，跨过午夜自动从 0 重新开始。
- 只有工作日才计时；休息日判定与倒计时完全一致。
- 加班托盘菜单：禁用标题行、禁用行 `工作日 19:00 起算`、分隔线、
  `设置…`（`⌘,`）、`退出`（`⌘Q`）。
- 关闭「开启加班计时」后第二个托盘立即移除；重新开启后恢复。

### 托盘菜单（倒计时）

- 头部实时状态；
- `上班 10:00 · 下班 19:00`；
- 休息日说明：`双休 · 周六、周日休息`、`单休 · 周日休息`、
  `本周：双休周` / `本周：单休周`、`本月：第3周 双休`、`自定义休息日 · 周一、周三`；
- `monthly` 模式下额外的「本周休息安排」子菜单（双休/单休，立即写入）；
- 午休启用时：`距午休 HH:MM:SS` 与 `午休 12:00–13:00`；
- 加班详情行（禁用）；
- `设置…`（`⌘,`）、`开机启动`（勾选式）、`退出`（`⌘Q`）。

### 休息日（动态工作日）

| `restMode` | 语义 | 休息日 |
| --- | --- | --- |
| `double`（默认） | 双休 | 周六、周日 |
| `single` | 单休 | 仅周日；**周六是工作日** |
| `alternating` | 大小休 | 双休周：周六+周日；单休周：仅周日 |
| `monthly` | 按月四周 | 按 `weeklyPlan` 逐周：双休周周六+周日；单休周仅周日 |
| `custom` | 自定义 | `customRestDays` 中勾选的所有星期几 |

**大小休**：以周一为一周起点，`alternating.anchorDate` 所在周由
`anchorIsDouble` 决定，此后每周交替。设置窗口保存时写入
`anchorDate = 本周周一`、`anchorIsDouble = 复选框值`。

**按月四周**：`weeklyPlan` 是 `{ "周一日期": "double" | "single" }`；
未配置的周按 `double`；非周一键在读取时归一到所在周一；非法项丢弃。
菜单显示 `本月：第N周 双休/单休`。

**设置窗口里的月排班器**：标题行 `‹ 2026年11月 ›` +「回到本月」，
列出与本月相交的周一制周（`第1周 · 10/26–11/01`），当前周带「本周」标记，
每行一个「双休/单休」复选框，只改内存，保存时才整份写入。

**自定义休息日**：`customRestDays` 是星期数字数组（0=周日 … 6=周六），
默认 `[0,6]`；允许空数组（每天都是工作日）。

### 下班通知

- `notifyAtEnd`：下班时间到时通知；`notifyBeforeMinutes`：提前 N 分钟提醒
  （0–120，0 关闭）。
- 只在应用运行期间、工作日触发；休息日不通知。
- 每种通知每天最多一次，用 `notify-state.json` 去重。
- 保存设置后会重置内存里的对比基线。

### 喝水提醒（v1.4.0）

| 设置 | 默认值 | 范围 | 说明 |
| --- | --- | --- | --- |
| `water.enabled` | `true` | boolean | 启用喝水提醒 |
| `water.intervalMinutes` | `45` | 1–600 | 每隔 N 分钟提醒一次 |
| `water.goalMl` | `2000` | 100–10000 | 每日目标 |
| `water.cupMl` | `250` | 50–2000 | 每次记录/「+1 次」的默认量 |
| `water.workHoursOnly` | `true` | boolean | 仅工作时间提醒 |

- 提醒由主进程现有的 **1 秒 tick** 驱动（不额外创建定时器）：到点弹出一条
  macOS 原生通知，标题 `喝水提醒`，正文 `该喝水了 · 起身接杯水，补充点水分。`。
- 勾选「仅工作时间提醒」时，只在**工作日**且 `workStart <= now < workEnd`
  的时段触发；休息日判定复用倒计时逻辑（双休/单休/大小休/按月四周/自定义）。
  关闭后任意时间（只要应用在运行）都可能触发。
- 启动、保存设置、跨天、离开工作时间都会把间隔基线重置为当前时刻，
  因此不会一启动就补发；同一间隔内最多提醒一次。
- 设置窗口「喝水提醒」标签页可记录：`+1 次（按 cupMl）`、快捷 `+150/+200/+300`、
  自定义 ml +「记录」。每条记录保存时间（`HH:MM`）与 ml。
- 「今日已喝」显示 `总 ml / 目标 ml` 和百分比 + 进度条，记录/清空后立即更新。
- 「今日记录」按时间列出；「清空今日记录」是弱化文字按钮。
- 记录持久化到 `water-state.json`；跨天读取或记录时自动重置为新的一天。

### 休息提醒（v1.4.0）

| 设置 | 默认值 | 范围 | 说明 |
| --- | --- | --- | --- |
| `rest.enabled` | `true` | boolean | 启用休息提醒 |
| `rest.intervalMinutes` | `45` | 1–600 | 每隔 N 分钟提醒一次 |
| `rest.durationMinutes` | `5` | 1–120 | 每次休息时长（文案） |
| `rest.workHoursOnly` | `true` | boolean | 仅工作时间提醒 |

- 到点通知：标题 `休息提醒`，正文 `该休息一下了 · 起身活动 5 分钟`。
- 调度语义与喝水提醒一致（1s tick、仅运行期间、基线重置、每间隔最多一次）。

### 设置窗口（v1.4.0）

- 窗口标题固定为 **`WORK OR RUN`**；约 **640×760**（`useContentSize`，
  并按屏幕可用区域收敛，小屏不会超出屏幕），不可缩放；内容区按标签页内部滚动，
  底部固定「取消 / 保存」。
- 顶部是品牌区 + 标签栏：**倒计时 / 喝水提醒 / 休息提醒 / 设置 / 关于**。
- **倒计时**：工作时间 / 休息日（含月排班器）/ 午休 / 加班 / 提醒，行为与 v1.3.0 一致。
- **喝水提醒**：启用、间隔、每日目标、每次量、仅工作时间；记录按钮、进度条、
  今日记录、清空。
- **休息提醒**：启用、间隔、每次休息时间、仅工作时间。
- **设置**：高亮颜色（预设橙/绿/蓝/紫/粉/红 + 自定义 color picker）、主题模式、
  更新源、作者/版本、检测更新。
- **关于**：作者：黄溢球、当前版本、项目简介、检测更新、发现新版本时的
  「前往 GitHub 发布页」。
- **Esc** 取消（不保存），**⌘Enter** 保存；保存前在主进程再次完整校验，
  任何非法输入都会显示中文错误，**不会写入** `settings.json`。
- 仍使用 `contextIsolation: true` + preload `contextBridge` + `ipcRenderer.invoke`；
  preload 只暴露白名单方法（load/save/cancel/close、主题预览、喝水读写、
  更新检查/打开 Release）。
- 设置窗口的浅色/深色**不依赖 `prefers-color-scheme`**：主进程按
  `appearance.themeMode` 解析出 `light`/`dark`，通过 `data-theme` 和
  `theme:changed` 推送；CSS 变量 `--bg/--card/--text/...` 分别定义两套主题。
- 高亮色实时预览（点击色块或取色器立即生效），保存后持久化；进度条、当前标签、
  保存按钮、勾选框、聚焦框都使用该颜色。
- 主题模式：
  - `system`：跟随 Electron `nativeTheme.shouldUseDarkColors`；
  - `sun`：日出~日落之间浅色，其余深色，使用可配置的 `sunrise`/`sunset`
    （默认 06:30 / 18:00），UI 明确说明这是**可手动配置的近似值**；
  - `light` / `dark`：强制。
- 修改模式/日出/日落会调用主进程 `settings:preview-theme` 预览；系统外观变化时
  主进程通过 `nativeTheme.on('updated')` 推送。

### 检测更新（v1.4.0）

- 主进程 `checkForUpdates()`：
  `GET https://api.github.com/repos/<owner/repo>/releases/latest`，
  带 `User-Agent: OffWorkCountdown/<version>` 与 `Accept: application/vnd.github+json`；
  8 秒超时，最多 3 次重定向，响应体上限 2 MB。
- 解析 `tag_name` / `name` / `html_url`，用纯函数 `parseSemver` /
  `compareVersions` 与运行版本比较；返回统一结构：

  ```json
  {
    "status": "latest | update | error",
    "currentVersion": "1.4.0",
    "latestVersion": "1.5.0",
    "url": "https://github.com/<owner>/<repo>/releases/tag/v1.5.0",
    "message": "发现新版本 v1.5.0"
  }
  ```

- 失败一律返回 `status: "error"` 与清晰中文消息，绝不抛异常/崩溃：
  - 404：`仓库还没有发布 Release（HTTP 404）`；
  - 403：`GitHub API 访问受限或超出频率限制（HTTP 403）`；
  - 网络/超时/JSON 损坏/其它 HTTP 状态：各自的明确消息。
- 「检测更新」按钮先显示 `正在检查…`，完成后显示
  `已是最新版本 v1.4.0` / `发现新版本 vX.Y.Z` / 失败原因；
  发现新版本时显示「前往 GitHub 发布页」，点击由主进程 `shell.openExternal`
  打开（只允许 `https://github.com/...`）。
- **离线/测试环境优雅禁用**：`OFFWORK_SELFTEST=1` 或 `OFFWORK_OFFLINE=1` 时
  直接返回 `更新检查已禁用（离线/测试环境）。`，不发起网络请求；检查是异步的，
  不阻塞设置窗口。

### 首次启动 / 版本变化自动打开设置

- `settings.json` 新增 `lastSeenVersion`（规范化为 `x.y.z`，非法为空）。
- 启动时由纯函数 `shouldAutoOpenSettings` 判定：
  - 设置文件不存在（首次安装）→ 打开；
  - `lastSeenVersion !== app.getVersion()`（升级后首次启动）→ 打开；
  - 版本相同 → 不打开；
  - 自检（`OFFWORK_SELFTEST=1` / `--selftest`）→ 永不打开。
- 判定后先持久化 `lastSeenVersion`，再打开窗口，保证只自动打开一次。
- 因此 v1.3.0 用户第一次启动 v1.4.0 会自动看到设置窗口（预期行为）；
  第二次启动不会再次打开。

---

## 启动方式

```bash
open "/Users/apple/Documents/deepseek-harness/default-workspace/mac-app/OffWorkCountdown.app"
```

启动后**不会出现 Dock 图标**；请到屏幕右上角菜单栏查看「半轮落日」图标 +
倒计时文字，以及「月牙」图标 + 加班时长（开启时）。

退出：菜单栏图标 →「退出」，或：

```bash
pkill -f "OffWorkCountdown.app/Contents/MacOS/DeepSeek Harness"
```

> 应用包内的可执行文件仍叫 `DeepSeek Harness`（复用的 Electron 运行时要求，
> 重命名会导致 Electron 找不到 Helper 进程），但 `CFBundleIdentifier` 为
> `com.local.offworkcountdown`，显示名称为「下班倒计时」，
> `CFBundleShortVersionString` / `CFBundleVersion` 均为 `1.4.0`。

---

## DMG 安装包与 release.sh

> 本版 **1.4.0 没有在此工作目录构建 DMG**（按交付约定由后续 Lead 打包）。
> `dist/` 中现有的是 **1.3.0 历史安装包**，不包含 v1.4.0 的改动。
> 新增的 `release.sh` 是给普通终端使用的打包/发布辅助脚本。

`release.sh`：

```bash
cd mac-app
./release.sh                 # 调用 build.sh，然后打包 dist/OffWorkCountdown-1.4.0-arm64.dmg
./release.sh --skip-build    # 直接用现有 .app 打包（仍会校验版本/签名）
./release.sh --publish       # 打包后若检测到 gh CLI，则 gh release create v1.4.0 ...
```

脚本会：

1. 读取 `package.json` 的 `version`，校验 `Info.plist` 的
   `CFBundleShortVersionString` 与之一致；
2. 校验 `codesign --verify --deep --strict`；
3. 准备 staging（App + `Applications` 软链 + 中文《安装说明.txt》）；
4. 用标准 `hdiutil create -volname "下班倒计时" -srcfolder ... -ov -format UDZO`
   生成 DMG，并用 `hdiutil verify` / `.sha256` 校验；
5. 打印手动创建 GitHub Release 的步骤；若 `gh` 存在且传入 `--publish`，
   直接执行 `gh release create v<version> <dmg> --title ... --notes ...`。

安装 DMG：打开镜像，把 `OffWorkCountdown.app` 拖到 `Applications`；首次打开若
提示“无法验证开发者”，右键 →「打开」，或：

```bash
xattr -dr com.apple.quarantine /Applications/OffWorkCountdown.app
```

（本 App 为 ad-hoc 签名、未做苹果公证，属正常现象。）

---

## 发布到 GitHub

> 从零开始的上传与发版教程（含命令、账号认证、Release、更新源配置、常见问题）见
> [GITHUB_UPLOAD.md](GITHUB_UPLOAD.md)。

### 1. 创建仓库

1. 在 GitHub 新建仓库，例如 `BALLBALLUUUUU/WORK-OR-RUN`；
2. 把 `mac-app/` 源码提交并推送：

   ```bash
   cd mac-app
   git init
   git add .
   git commit -m "OffWorkCountdown v1.4.0"
   git branch -M main
   git remote add origin git@github.com:<owner>/<repo>.git
   git push -u origin main
   ```

### 2. 设置更新源

两种方式（任选其一，必须指向**同一个真实仓库**）：

- **在 App 内修改（推荐）**：设置 → 设置 → 更新源，填 `owner/repo`，保存。
  该值持久化在 `settings.json` 的 `updateRepo`。
- **改默认常量**：编辑 `countdown.js` 的
  `const DEFAULT_UPDATE_REPO = 'BALLBALLUUUUU/WORK-OR-RUN';`，改成你的仓库后重新构建。

> 本项目默认更新源已设为真实仓库 `BALLBALLUUUUU/WORK-OR-RUN`。
> 如果要换仓库，改 App 内「设置 → 更新源」，或修改常量后重新构建。

### 3. 提升版本并重新构建

发版前要同步修改：

1. `package.json` 的 `version`（`build.sh` 会写入 Info.plist 的
   `CFBundleShortVersionString` / `CFBundleVersion`）；
2. `main.js` 自检里的版本断言（`meta.version === '1.4.0'` 与 `v1.4.0`）；
3. `settings.html` 中两个版本占位文案（`settingsVersion` / `metaVersion`
   会在运行时被 `meta.version` 覆盖，但静态值建议同步）；
4. 本 README 的版本号/变更说明。

然后：

```bash
cd mac-app
node test-countdown.js
./build.sh
```

### 4. 上传 DMG 到 Release

```bash
./release.sh --publish        # gh 已登录时自动创建 Release
```

或手动：

1. 仓库 → **Releases** → **Draft a new release**；
2. **Tag** 填 `v1.4.0`（必须与 `package.json` 的版本对应，可带 `v` 前缀）；
3. 标题如「下班倒计时 v1.4.0」，粘贴更新说明；
4. 上传 `dist/OffWorkCountdown-1.4.0-arm64.dmg`；
5. **Publish release**。

### 5. 「检测更新」如何找到它

- App 读取 `https://api.github.com/repos/<updateRepo>/releases/latest`，
  即 GitHub 的**最新正式 Release**（草稿/预发布不算）；
- 解析其 `tag_name`（如 `v1.5.0`），与运行版本做语义化比较；
- 若最新 tag 比当前版本新，显示「发现新版本 vX.Y.Z」与「前往 GitHub 发布页」，
  链接使用 Release 的 `html_url`，由系统浏览器打开；
- **App 只检查、不下载/不自动安装**；用户从 Release 页面下载 DMG 覆盖安装。
- GitHub 未认证 API 有频率限制（403 时会显示明确提示）。

---

## 设置与数据位置

| 内容 | 路径 |
| --- | --- |
| 设置 | `~/Library/Application Support/OffWorkCountdown/settings.json` |
| 喝水记录 | `~/Library/Application Support/OffWorkCountdown/water-state.json` |
| 通知去重 | `~/Library/Application Support/OffWorkCountdown/notify-state.json` |
| 运行日志 | `~/Library/Application Support/OffWorkCountdown/offwork.log` |

`settings.json` 结构（v1.4.0，示例；实际值以用户文件为准）：

```json
{
  "workStart": "10:00",
  "workEnd": "19:00",
  "restMode": "monthly",
  "customRestDays": [0, 6],
  "alternating": {
    "anchorDate": "2026-11-09",
    "anchorIsDouble": true
  },
  "weeklyPlan": {
    "2026-10-26": "single",
    "2026-11-02": "single",
    "2026-11-23": "single",
    "2026-11-30": "double"
  },
  "lunch": { "enabled": true, "start": "12:00", "end": "13:00" },
  "overtime": { "enabled": true, "start": "19:00" },
  "notifyAtEnd": true,
  "notifyBeforeMinutes": 5,
  "launchAtLogin": true,
  "water": {
    "enabled": true,
    "intervalMinutes": 45,
    "goalMl": 2000,
    "cupMl": 250,
    "workHoursOnly": true
  },
  "rest": {
    "enabled": true,
    "intervalMinutes": 45,
    "durationMinutes": 5,
    "workHoursOnly": true
  },
  "appearance": {
    "themeMode": "system",
    "accent": "#F5A65B",
    "sunrise": "06:30",
    "sunset": "18:00"
  },
  "updateRepo": "BALLBALLUUUUU/WORK-OR-RUN",
  "lastSeenVersion": "1.4.0"
}
```

| 字段 | 类型 / 范围 | 默认 | 说明 |
| --- | --- | --- | --- |
| `workStart` / `workEnd` | `HH:MM` | 09:00 / 18:00 | 同一天内的班次 |
| `restMode` | `double/single/alternating/monthly/custom` | `double` | 休息日模式 |
| `customRestDays` | `number[]`（0–6） | `[0,6]` | 自定义休息日 |
| `alternating.anchorDate` | `YYYY-MM-DD` | 本周周一 | 大小休基准周 |
| `alternating.anchorIsDouble` | `boolean` | `true` | 基准周是否双休 |
| `weeklyPlan` | `{ "YYYY-MM-DD": "double"\|"single" }` | `{}` | 月排班，键归一为周一 |
| `lunch.enabled` | `boolean` | `true` | 午休开关 |
| `lunch.start` / `lunch.end` | `HH:MM` | 12:00 / 13:00 | 午休 `[start,end)` |
| `overtime.enabled` | `boolean` | `true` | 加班计时开关 |
| `overtime.start` | `HH:MM` | 等于 `workEnd` | 加班起算 |
| `notifyAtEnd` | `boolean` | `true` | 下班时通知 |
| `notifyBeforeMinutes` | 整数 0–120 | `0` | 提前提醒，0=关闭 |
| `launchAtLogin` | `boolean` | `false` | 最近一次开机启动偏好 |
| `water.enabled` | `boolean` | `true` | 喝水提醒开关 |
| `water.intervalMinutes` | 整数 1–600 | `45` | 喝水提醒间隔 |
| `water.goalMl` | 整数 100–10000 | `2000` | 每日目标 |
| `water.cupMl` | 整数 50–2000 | `250` | 每次默认量 |
| `water.workHoursOnly` | `boolean` | `true` | 仅工作时间 |
| `rest.enabled` | `boolean` | `true` | 休息提醒开关 |
| `rest.intervalMinutes` | 整数 1–600 | `45` | 休息提醒间隔 |
| `rest.durationMinutes` | 整数 1–120 | `5` | 每次休息时长 |
| `rest.workHoursOnly` | `boolean` | `true` | 仅工作时间 |
| `appearance.themeMode` | `system/sun/light/dark` | `system` | 主题模式 |
| `appearance.accent` | `#RRGGBB`（大小写不敏感） | `#F5A65B` | 高亮色 |
| `appearance.sunrise` / `sunset` | `HH:MM` | 06:30 / 18:00 | 日出日落近似时间，必须日出 < 日落 |
| `updateRepo` | `owner/repo` | `BALLBALLUUUUU/WORK-OR-RUN` | GitHub 更新源 |
| `lastSeenVersion` | `x.y.z` 或空 | `""` | 上次启动的 App 版本 |

`water-state.json`（v1.4.0）：

```json
{
  "day": "2026-11-09",
  "totalMl": 750,
  "records": [
    { "at": "09:35", "ml": 250 },
    { "at": "11:10", "ml": 250 },
    { "at": "14:05", "ml": 250 }
  ]
}
```

- `day` 不是今天时，读取或记录都会自动重置为 `{day: 今天, totalMl: 0, records: []}`；
- 非法记录（时间格式错误、ml 非正整数/过大）会被丢弃，`totalMl` 以合法记录之和为准；
- 文件损坏/不是 JSON 时安全重置为空，不崩溃；
- 写入同样使用「临时文件 + rename」的原子写。

---

## 容错与迁移

- **v1.3.0 → v1.4.0**：新增 `water` / `rest` / `appearance` / `updateRepo` /
  `lastSeenVersion`，缺失时补默认值；**保留所有已有字段和用户值**
  （`workStart`/`workEnd`/`restMode`/`weeklyPlan`/`lunch`/`overtime`/通知/
  `launchAtLogin` 等）。
- **v1.2.0 → v1.3.0**：设置结构不变，仅新增菜单栏图标着色。
- **v1.1.0 → v1.2.0**：自动补 `weeklyPlan: {}` 与
  `overtime: { enabled: true, start: workEnd }`。
- **旧版 `notify` → `notifyAtEnd`**：读取时迁移并删除旧字段，日志记录
  `settings migrated: notify=... -> notifyAtEnd=...`。
- 缺失字段补默认值；类型错误/非法时间回退默认值。
- 非法 `restMode` → `double`；非法 `customRestDays` → `[0,6]`；
  非法大小休锚点 → 本周周一 + 双休。
- 非法 `weeklyPlan` 项被丢弃（合法项保留）；`overtime` 非法时回退
  `enabled=true`、`start=workEnd`。
- `lunch.enabled=true` 但结束不晚于开始 → 视为关闭午休。
- 非法 `notifyBeforeMinutes` → `0`。
- 非法喝水/休息数值：读取时回退默认值；**保存时直接拒绝**（不落盘）。
- 非法 `appearance.themeMode` → `system`；非法颜色 → 默认 `#F5A65B`；
  日出 ≥ 日落 → 回退 06:30–18:00。
- 非法 `updateRepo` → 默认常量；`lastSeenVersion` 非法 → 空。
- 写入采用「临时文件 + rename」的原子写；保存前校验失败不会碰磁盘文件。

---

## 从源码重新构建

前置条件（本机已具备）：

- 已安装 Electron 应用作为运行时来源，默认 `/Applications/DeepSeek Harness.app`
  （可用环境变量 `ELECTRON_SRC` 指向别的 Electron App）。
- Python 3 + Pillow（默认使用 DSH 自带运行时，也可用 `PYTHON=...` 指定）。
- Node.js 仅用于跑单元测试（默认 DSH 自带 node）。

```bash
cd mac-app
node test-countdown.js
./build.sh            # 重建负载、图标、Info.plist 并 ad-hoc 重新签名
./build.sh --fresh    # 先删掉 .app，再从 ELECTRON_SRC 复制 Electron 运行时（约 1 GB）
```

单独复验图标像素 / 居中：

```bash
python3 make-icons.py --verify assets
```

构建脚本会：

1. 用 Pillow 绘制原创图标（黄昏渐变 + 落日 + 海平线）、两个菜单栏模板图标
   （`SunClockTemplate*` = 半轮落日，`OvertimeTemplate*` = 月牙 + 星点），
   以及同形状的 **4 个主图标彩色变体 + 2 个加班图标彩色变体**（16×16 与
   32×32@2x，非模板、透明背景）；
2. 校验主色是否等于约定 hex（容差 6），并计算每个主状态图标的 alpha bbox
   中心/笔画质量/跨度（P1），失败会让构建失败；
3. 删除 `Contents/Resources/app.asar`、`default_app.asar`、`app.asar.unpacked`，
   写入 `Contents/Resources/app/`（Electron 在没有 asar 时加载该目录）；
4. 用 `PlistBuddy` 修改 `Info.plist`：`CFBundleIdentifier=com.local.offworkcountdown`、
   `CFBundleDisplayName=下班倒计时`、`CFBundleIconFile=OffWorkCountdown.icns`、
   `LSUIElement=true`，并用 `package.json` 的 `version` 写入
   `CFBundleShortVersionString` / `CFBundleVersion`；删除 `ElectronAsarIntegrity`
   与 `dsh` URL scheme 注册；**保留** `CFBundleName` 与 `CFBundleExecutable`
   为 `DeepSeek Harness`（不改 Helper 名称）；
5. `xattr -cr` 后 `codesign --force --deep --sign -` 做 ad-hoc 签名，并用
   `codesign --verify --deep --strict` 校验。

---

## 目录结构

```
mac-app/
├── OffWorkCountdown.app/       构建产物（可直接双击）
├── build.sh                    重建脚本
├── release.sh                  构建 + DMG + GitHub Release 辅助脚本
├── package.json                Electron 应用清单（version=1.4.0）
├── main.js                     主进程：托盘、菜单、通知、设置/水/更新 IPC、自检
├── countdown.js                纯逻辑：休息日/月排班/午休/加班/通知/水/提醒/版本/主题
├── preload.js                  contextBridge 白名单 API
├── settings.html               设置窗口（640×760，五个标签页，中文，显式主题）
├── settings.js                 设置窗口渲染、校验、实时预览、喝水记录
├── make-icons.py               原创图标生成 + 像素/居中校验（Pillow）
├── test-countdown.js           countdown.js 单元测试（61 项）
├── assets/
│   ├── OffWorkCountdown.icns   应用图标
│   ├── icon-1024.png           1024 图标源图
│   ├── SunClockTemplate.png/@2x 倒计时菜单栏模板图标 16/32
│   ├── OvertimeTemplate.png/@2x 加班菜单栏模板图标 16/32
│   ├── SunClockWork/Lunch/Overtime/Rest.png/@2x 主图标彩色变体
│   ├── OvertimeCounting/Idle.png/@2x 加班托盘彩色变体
│   └── preview/                预览图（不进入 app 包）
└── README.md
```

应用包内对应位置：`Contents/Resources/app/{package.json,main.js,countdown.js,preload.js,settings.html,settings.js,assets/}`。

---

## 测试

### 1）纯逻辑单元测试（61 项）

```bash
cd mac-app
node test-countdown.js
```

覆盖 v1.3.0 的全部 41 项，并新增：

- **语义化版本**：`parseSemver`（v 前缀、缺省 minor/patch、预发布、非法）、
  `compareVersions`（`v1.4.0` = `1.4` = `1.4.0`、大小、alpha/beta/数字标识符、
  构建元数据、非法输入）、`isNewerVersion`；
- **更新结果映射**：`updateResultFromRelease`（latest/update/非法 tag/非法 JSON/
  html_url 回退）、`updateErrorResult`（404/403/网络/超时/禁用/malformed/其它 HTTP）；
- **设置模型**：v1.3 旧设置升级保留所有用户值 + 新字段默认；喝水/休息数值范围；
  主题/颜色/日出日落/更新源校验；`normalizeAccent`（#RGB 展开、大小写、非法）；
  `normalizeUpdateRepo`、`sanitizeLastSeenVersion`；
- **主题解析**：`resolveTheme` 的 system/light/dark/sun，日出/日落边界，
  自定义时间，非法倒序回退；
- **喝水状态**：跨天重置、非法记录丢弃、total 重算、追加记录、非法金额、清空、
  百分比四舍五入与封顶；
- **提醒调度**：`isWithinWorkHours` 边界/休息日、`reminderEligible`、
  `reminderDue`（间隔/基线/跨天/工作时间外/关闭）、`reminderNotification` 文案；
- **自动打开设置**：首次安装/版本变化/同版本/自检。

本机结果：**61 项检查通过**。

### 2）应用内自检（无界面，84 项）

自检会自动使用隔离的临时 userData（`/tmp/offwork-selftest-<pid>`），
结束后删除该目录，并把日志复制到 `/tmp/offwork-selftest-result.log`，
**绝不会写真实 `settings.json`**。

```bash
OFFWORK_SELFTEST=1 "OffWorkCountdown.app/Contents/MacOS/DeepSeek Harness"
# 或
"OffWorkCountdown.app/Contents/MacOS/DeepSeek Harness" --selftest
```

自检覆盖 v1.3.0 的 55 项（图标/状态映射/托盘切换/菜单/月排班/加班/非法输入/
真实设置 SHA-256），并新增：

- 五个标签页存在且点击切换只显示一个面板；窗口标题 `WORK OR RUN`；
- 喝水 IPC：记录 +250/+150、总量/时间/`water-state.json`、百分比、非法金额拒绝、
  界面按钮即时更新进度（+150 → 8%）、清空；损坏 JSON 安全重置；
- 休息提醒与喝水提醒的非法范围在 IPC 层拒绝；
- 新字段合法保存与持久化、提醒基线重置、旧字段保留；
- 主题解析 IPC（light/dark/system/sun）与渲染进程实时预览（深/浅色、高亮色、
  日出日落输入显隐）；
- 更新检查失败路径（自检环境禁用 → 清晰错误、不崩溃）、非 GitHub URL 拒绝；
- 自动打开设置的版本变化逻辑；
- **P1 图标**：`nativeImage` 解码 PNG，校验午休图标 16/32 的 alpha bbox 中心
  ±1px，以及四个主状态图标的居中和质量/跨度比例；
- 真实用户 `settings.json` 内容与 SHA-256 前后一致。

最后一行应为 `SELFTEST PASS (84/84)`。

> 本机 shell 受沙箱限制，直接执行 `Contents/MacOS/DeepSeek Harness` 会静默退出，
> `open --args` 也不转发参数；因此验收采用「临时强制 SELFTEST → `open` 启动 →
> 读取结果 → 还原源码 → 重新构建干净包」的流程。最终交付包中没有任何强制自检代码。

---

## 已验证 / 未验证

**已验证（本机 2026-11-09，macOS 27.2 arm64）**

- **P1 图标**：`make-icons.py --verify assets` 全部通过；午休图标
  16×16 bbox 中心 `(7.50, 7.50)`、32×32 中心 `(15.50, 15.50)`，偏移均为
  `(0.00, 0.00)`；笔画质量 62/242 px（相对月牙 1.11/1.12），最大跨度比 1.17；
  work/overtime/rest 同几何同数值。
- **彩色图标颜色**：12 个彩色 PNG 主色与约定 hex 一致（容差 6）。
- `codesign --verify --deep --strict` 通过，ad-hoc 签名；`plutil` 校验通过。
- 版本：`package.json`、`CFBundleShortVersionString`、`CFBundleVersion` 均为
  `1.4.0`；源码与 `Contents/Resources/app/` 负载逐字节一致；最终包中没有强制
  自检代码。
- 真实用户设置由升级/自检原样保留：升级前 SHA-256
  `c669f418e5fc7ad908c52c559eb1e1e2739c9b93ac93300f80bef5b7ae71b580`，
  自检前后内容与哈希一致；`workStart=10:00`、`workEnd=19:00`、`restMode=monthly`、
  `weeklyPlan` 四项（含 12:13:42 修改的 `2026-11-23=single`、
  `2026-11-30=double`）、`lunch=12:00–13:00`、`overtime={enabled:true,start:"19:00"}`、
  `notifyAtEnd=true`、`notifyBeforeMinutes=5`、`launchAtLogin=true` 全部保留，
  并新增默认字段与 `lastSeenVersion=1.4.0`。
- 单元测试 **61/61**；应用内自检 **84/84**（`SELFTEST PASS (84/84)`），
  自检使用临时 userData 并已清理。
- 最终包以 `open` 启动，进程持续存活（当前 `pid=26436`，v1.4.0）；日志确认
  两个 Tray、彩色状态、`lastSeenVersion` 更新与 **自动打开设置一次**：
  - 首次 v1.4.0 启动（`pid=25030`）：`lastSeenVersion: (none) -> 1.4.0`、
    `auto-open settings: hadSettingsFile=true lastSeenVersion=(none) appVersion=1.4.0`、
    `settings window opened size=640x760 theme=light`；
  - 之后重复启动：`auto-open settings skipped: lastSeenVersion=1.4.0
    appVersion=1.4.0`，设置窗口未被自动再次打开。
- 无崩溃：`~/Library/Logs/DiagnosticReports` 中没有该 Bundle 的崩溃报告，
  userData 下没有 crashpad dump。
- 单实例、`LSUIElement`、Helper 名称、登录项行为未改动。

**未验证**

- **真实界面/菜单栏像素效果**：本机无屏幕录制权限，无法截图确认五个标签页的
  实际渲染、640×760 布局、内部滚动、浅色/深色主题、高亮色、进度条和菜单栏
  彩色图标在真实菜单栏中的位置/对比度；这些只通过 DOM/逻辑自检、PNG 像素校验
  与日志间接确认。
- **系统通知横幅**：没有等到提醒间隔/下班时间主动触发，避免打扰；通知文案与
  调度由纯函数单测和自检覆盖，真实横幅仍取决于「系统设置 → 通知」权限。
- **真实 GitHub Release**：本机未发布任何仓库/Release；只验证了自检/离线失败路径
  与纯函数映射，未对真实 `api.github.com` 成功响应做端到端测试。
- **开机启动**：按约束未在测试中添加/删除登录项，真实登录项行为需用户自行确认。
- **跨午夜/跨周/跨月长时间观察**：由纯函数单测覆盖，未做整夜/数月人工观察。
- 其它机器上的 Gatekeeper 行为：ad-hoc 签名未公证，跨机器拷贝后首次打开可能需要
  右键 →「打开」或 `xattr -dr com.apple.quarantine`。

---

## 已知限制

- 只支持同一天内的班次（`workEnd` 必须晚于 `workStart`），不支持跨天/夜班。
- 午休只支持同一天内、结束晚于开始；午休窗口跨过下班时间时优先「已下班」。
- 大小休以周一为一周起点，按自然周无限交替；没有节假日/调休日历。
- 按月四周按自然周排班，没有节假日/调休日历，也不支持一天内多段休息。
- 加班只按「当天」累计，跨午夜自动归零。
- 提前提醒最多 120 分钟，且只在应用运行期间跨过阈值时触发。
- 喝水/休息提醒只在应用运行期间触发；关机/退出后不会补发。
- 提醒间隔基线在启动、保存设置、跨天、离开工作时间时重置，因此刚改完设置
  或刚进入工作时间不会立刻提醒。
- 更新检查只比较 GitHub **最新正式 Release** 的 tag，不处理草稿/预发布；
  GitHub 未认证 API 有频率限制。
- 「跟随日出日落」使用用户配置的固定时间，不是真实天文计算。
- 菜单栏文字宽度随剩余时间变化；菜单栏空间紧张时系统可能折叠图标。
- 彩色菜单栏图标为非模板图，不随浅色/深色菜单栏自动反色。
- 应用包约 600 MB：复用了完整 Electron 运行时。
- 应用依赖原 Electron 运行时的 Helper 名称，包内可执行文件仍叫
  `DeepSeek Harness`；升级 Electron 时按 `build.sh --fresh` 重新复制。

---

## 卸载

1. 菜单栏图标 →「退出」；
2. 删除 `OffWorkCountdown.app`；
3. 删除 `~/Library/Application Support/OffWorkCountdown/`
   （设置、喝水记录、日志与通知去重状态）。
