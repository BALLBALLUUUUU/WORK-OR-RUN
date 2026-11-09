'use strict';

/**
 * 下班倒计时 —— macOS 菜单栏应用主进程（只做胶水：托盘/菜单/通知/设置 IO）。
 *
 * 设计要点：
 *  - LSUIElement 应用，仅菜单栏常驻，不占 Dock。
 *  - 每秒刷新 Tray 标题；菜单每次打开时重建，保证头部剩余时间最新。
 *  - 设置窗口使用 contextIsolation + preload + ipcRenderer.invoke。
 *  - 设置持久化到 userData/settings.json，采用“临时文件 + rename”的原子写。
 *  - 所有时间/休息日/午休/通知阈值判断都在 countdown.js（纯函数，可单测）。
 */

const {
  app,
  Menu,
  Tray,
  BrowserWindow,
  Notification,
  nativeImage,
  nativeTheme,
  screen,
  shell,
  ipcMain,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const https = require('node:https');

const {
  sanitizeSettings,
  validateSettings,
  computeStatus,
  computeOvertime,
  trayAccentState,
  dayKey,
  mondayKey,
  alternatingWeekIsDouble,
  resolveWeekPlan,
  formatDuration,
  notificationEvents,
  // v1.4.0
  WATER_AMOUNT_MIN,
  WATER_AMOUNT_MAX,
  DEFAULT_UPDATE_REPO,
  addWaterRecord,
  clearWaterState,
  sanitizeWaterState,
  waterProgress,
  reminderDue,
  reminderEligible,
  reminderNotification,
  resolveTheme,
  shouldAutoOpenSettings,
  normalizeUpdateRepo,
  updateResultFromRelease,
  updateErrorResult,
} = require('./countdown');

const APP_NAME = '下班倒计时';

// ---------------------------------------------------------------------------
// 路径与日志：userData 固定为 ~/Library/Application Support/OffWorkCountdown
// （ASCII 路径，方便查找；自检时强制使用隔离的临时目录）
// ---------------------------------------------------------------------------
app.setName(APP_NAME);

/** 读取 --key=value 形式的命令行参数（用于自检/调试）。 */
function argValue(prefix) {
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

const SELFTEST =
  process.env.OFFWORK_SELFTEST === '1' || process.argv.includes('--selftest');
const USER_DATA_OVERRIDE =
  process.env.OFFWORK_USER_DATA || argValue('--user-data-dir=') || null;
const DATA_ROOT = app.getPath('appData');
const REAL_USER_DATA = path.join(DATA_ROOT, 'OffWorkCountdown');
const REAL_SETTINGS_FILE = path.join(REAL_USER_DATA, 'settings.json');

// 自检默认使用 /tmp/offwork-selftest-<pid>，结束后删除；即使误传真实目录也会被替换。
const SELFTEST_TEMP = `/tmp/offwork-selftest-${process.pid}`;
const SELFTEST_SUMMARY_FILE = '/tmp/offwork-selftest-result.log';
let USER_DATA = USER_DATA_OVERRIDE
  ? path.resolve(USER_DATA_OVERRIDE)
  : SELFTEST
    ? SELFTEST_TEMP
    : REAL_USER_DATA;
if (SELFTEST && USER_DATA === REAL_USER_DATA) USER_DATA = SELFTEST_TEMP;
app.setPath('userData', USER_DATA);

const SETTINGS_FILE = path.join(USER_DATA, 'settings.json');
const NOTIFY_STATE_FILE = path.join(USER_DATA, 'notify-state.json');
const WATER_STATE_FILE = path.join(USER_DATA, 'water-state.json');
const LOG_FILE = path.join(USER_DATA, 'offwork.log');
/** 启动时设置文件是否已存在（用于「首次安装自动打开设置」）。 */
const HAD_SETTINGS_FILE_AT_STARTUP = fs.existsSync(SETTINGS_FILE);

/** 自检开始前记录真实设置快照，用于证明自检没有写用户数据。 */
let realSettingsSnapshot = null;
let realSettingsHash = null;
try {
  realSettingsSnapshot = fs.readFileSync(REAL_SETTINGS_FILE, 'utf8');
  realSettingsHash = crypto
    .createHash('sha256')
    .update(realSettingsSnapshot)
    .digest('hex');
} catch {
  realSettingsSnapshot = null;
  realSettingsHash = null;
}

function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  try {
    fs.mkdirSync(USER_DATA, { recursive: true });
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch {
    /* 日志失败不影响主流程 */
  }
  console.log('[offwork]', message);
}

function readJsonFile(file) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (error) {
    return { ok: false, error };
  }
}

// ---------------------------------------------------------------------------
// 设置读写
// ---------------------------------------------------------------------------
let settings = sanitizeSettings({}, new Date());

function persistSettings(next) {
  fs.mkdirSync(USER_DATA, { recursive: true });
  const tmp = `${SETTINGS_FILE}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, SETTINGS_FILE);
}

function loadSettings() {
  const result = readJsonFile(SETTINGS_FILE);
  let raw = null;
  if (!result.ok) {
    if (result.error && result.error.code !== 'ENOENT') {
      log(`settings.json 读取失败，使用默认值：${result.error.message}`);
    }
    settings = sanitizeSettings({}, new Date());
  } else {
    raw = result.value;
    settings = sanitizeSettings(raw, new Date());
  }

  if (
    raw &&
    typeof raw === 'object' &&
    !('notifyAtEnd' in raw) &&
    typeof raw.notify === 'boolean'
  ) {
    log(`settings migrated: notify=${raw.notify} -> notifyAtEnd=${settings.notifyAtEnd}`);
  }

  const changed =
    !raw || typeof raw !== 'object' || JSON.stringify(raw) !== JSON.stringify(settings);
  if (changed) log('settings.json 含缺失或非法字段，已规范化并写回新格式。');

  try {
    persistSettings(settings);
  } catch (error) {
    log(`settings.json 写入失败：${error.message}`);
  }
  log(
    `settings loaded: ${JSON.stringify(settings)} file=${SETTINGS_FILE} userData=${USER_DATA}`,
  );
}

// ---------------------------------------------------------------------------
// 通知去重状态：{ day, end, before }，同一天每种通知最多一次
// ---------------------------------------------------------------------------
let notifyState = { day: '', end: false, before: false };

function loadNotifyState() {
  const result = readJsonFile(NOTIFY_STATE_FILE);
  const raw =
    result.ok && result.value && typeof result.value === 'object' ? result.value : {};
  let day = typeof raw.day === 'string' ? raw.day : '';
  let end = raw.end === true;
  let before = raw.before === true;
  // 兼容 v1.0.0 的 { lastNotifiedDate } 格式
  if (!day && typeof raw.lastNotifiedDate === 'string') {
    day = raw.lastNotifiedDate;
    end = true;
  }
  notifyState = { day, end, before };
}

function saveNotifyState() {
  try {
    fs.mkdirSync(USER_DATA, { recursive: true });
    fs.writeFileSync(
      NOTIFY_STATE_FILE,
      `${JSON.stringify(notifyState)}\n`,
      'utf8',
    );
  } catch (error) {
    log(`notify-state.json 写入失败：${error.message}`);
  }
}

function markNotified(key, type) {
  if (notifyState.day !== key) {
    notifyState = { day: key, end: false, before: false };
  }
  notifyState[type] = true;
  saveNotifyState();
}

// ---------------------------------------------------------------------------
// v1.4.0：喝水记录（water-state.json）
// 结构：{ day: 'YYYY-MM-DD', totalMl, records: [{ at: 'HH:MM', ml }] }
// 跨天自动重置；损坏/非法 JSON 容错为空状态，绝不崩溃。
// ---------------------------------------------------------------------------
let waterState = null;

function persistWaterState() {
  fs.mkdirSync(USER_DATA, { recursive: true });
  const tmp = `${WATER_STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(waterState, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, WATER_STATE_FILE);
}

function loadWaterState(now = new Date()) {
  const result = readJsonFile(WATER_STATE_FILE);
  if (!result.ok) {
    if (result.error && result.error.code !== 'ENOENT') {
      log(`water-state.json 读取失败，已重置：${result.error.message}`);
    }
    waterState = clearWaterState(now);
  } else {
    waterState = sanitizeWaterState(result.value, dayKey(now));
    if (result.value && result.value.day && result.value.day !== dayKey(now)) {
      log(`water-state.json 跨天重置：${result.value.day} -> ${dayKey(now)}`);
    }
  }
  try {
    persistWaterState();
  } catch (error) {
    log(`water-state.json 写入失败：${error.message}`);
  }
  return waterState;
}

function waterSnapshot(now = new Date()) {
  const today = dayKey(now);
  if (!waterState) {
    loadWaterState(now);
  } else if (waterState.day !== today) {
    waterState = clearWaterState(now);
    log(`water-state 跨天自动重置 -> ${today}`);
    try {
      persistWaterState();
    } catch (error) {
      log(`water-state.json 写入失败：${error.message}`);
    }
  }
  const progress = waterProgress(waterState.totalMl, settings.water.goalMl);
  return {
    day: waterState.day,
    totalMl: waterState.totalMl,
    records: waterState.records.map((record) => ({ ...record })),
    goalMl: progress.goalMl,
    percent: progress.percent,
    cupMl: settings.water.cupMl,
  };
}

function recordWater(ml, now = new Date()) {
  const next = addWaterRecord(waterState || clearWaterState(now), ml, now);
  if (!next) return null;
  waterState = next;
  try {
    persistWaterState();
  } catch (error) {
    log(`water-state.json 写入失败：${error.message}`);
  }
  log(`water recorded: +${ml}ml total=${waterState.totalMl}ml day=${waterState.day}`);
  return waterSnapshot(now);
}

function clearWater(now = new Date()) {
  waterState = clearWaterState(now);
  try {
    persistWaterState();
  } catch (error) {
    log(`water-state.json 写入失败：${error.message}`);
  }
  log(`water records cleared day=${waterState.day}`);
  return waterSnapshot(now);
}

// ---------------------------------------------------------------------------
// v1.4.0：喝水 / 休息提醒调度
// 由现有 1s tick 驱动（不额外创建定时器）：
//  - 启动、保存设置、跨天、离开工作时间都会重置基线，避免一启动就补发；
//  - 每次触发后把基线设为当前时刻，保证同一间隔内最多一次；
//  - 内存状态，不落盘（喝水记录本身持久化在 water-state.json）。
// ---------------------------------------------------------------------------
const reminderBaselines = {
  water: { atMs: null, day: '' },
  rest: { atMs: null, day: '' },
};

function resetReminderBaselines(now = new Date(), reason = '') {
  for (const kind of ['water', 'rest']) {
    reminderBaselines[kind] = { atMs: now.getTime(), day: dayKey(now) };
  }
  if (reason) log(`reminder baselines reset: ${reason}`);
}

function reminderConfig(kind) {
  return kind === 'water' ? settings.water : settings.rest;
}

function showReminder(kind, now = new Date()) {
  if (!Notification.isSupported()) {
    log(`系统不支持通知，跳过提醒 kind=${kind}`);
    return false;
  }
  const message = reminderNotification(kind, reminderConfig(kind));
  try {
    const notification = new Notification({
      title: message.title,
      body: message.body,
      silent: false,
    });
    notification.on('failed', (_event, error) =>
      log(`提醒发送失败 kind=${kind}：${error}`),
    );
    notification.show();
    log(
      `已发送提醒 kind=${kind} day=${dayKey(now)} title=${message.title} body=${message.body}`,
    );
    return true;
  } catch (error) {
    log(`提醒异常 kind=${kind}：${error.message}`);
    return false;
  }
}

function checkReminders(now = new Date()) {
  if (SELFTEST) return; // 自检不发送系统通知
  for (const kind of ['water', 'rest']) {
    const config = reminderConfig(kind);
    const baseline = reminderBaselines[kind];
    const today = dayKey(now);
    if (baseline.day !== today) {
      baseline.atMs = now.getTime();
      baseline.day = today;
      log(`reminder baseline 跨天重置 kind=${kind} day=${today}`);
    }
    if (!reminderEligible(config, settings, now)) {
      // 不在工作时间时持续对齐基线：进入工作时间后要等满一个间隔才提醒。
      baseline.atMs = now.getTime();
      continue;
    }
    if (reminderDue(config, settings, now, baseline.atMs, baseline.day)) {
      showReminder(kind, now);
      baseline.atMs = now.getTime();
      baseline.day = today;
    }
  }
}

// ---------------------------------------------------------------------------
// v1.4.0：主题解析（主进程解析，再把 light/dark 推给设置窗口）
// ---------------------------------------------------------------------------
let lastPublishedTheme = null;

function resolvedTheme(now = new Date()) {
  return resolveTheme(settings.appearance, now, nativeTheme.shouldUseDarkColors);
}

function publishTheme(force = false) {
  const theme = resolvedTheme();
  if (!force && theme === lastPublishedTheme) return theme;
  lastPublishedTheme = theme;
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    try {
      settingsWindow.webContents.send('theme:changed', { theme });
    } catch (error) {
      log(`推送主题失败：${error.message}`);
    }
  }
  return theme;
}

// ---------------------------------------------------------------------------
// 运行时状态
// ---------------------------------------------------------------------------
let tray = null;
let overtimeTray = null;
let settingsWindow = null;
let timer = null;
let previousStatus = null;
let previousOvertimeState = null;
let lastLoggedMinute = -1;
let lastMenuOpenedAt = 0;
let lastOvertimeMenuOpenedAt = 0;

// ---------------------------------------------------------------------------
// 彩色菜单栏图标
//  - 状态 -> 资源 / 颜色；nativeImage 按文件缓存，绝不在每秒 tick 里重建。
//  - 只有状态发生变化时才调用 setImage，并打印 `tray icon state=... color=...`。
//  - 彩色图必须是 non-template（template=true 会被系统强制单色）。
//  - 彩色资源缺失/Electron 拒绝时回退到原有模板图，保证菜单栏不空白。
// ---------------------------------------------------------------------------
const TRAY_ACCENT_STYLES = Object.freeze({
  work: { file: 'SunClockWork.png', color: '#F5A65B' },
  lunch: { file: 'SunClockLunch.png', color: '#8FD19E' },
  overtime: { file: 'SunClockOvertime.png', color: '#E5533D' },
  rest: { file: 'SunClockRest.png', color: '#9AA4B2' },
});
const OVERTIME_ACCENT_STYLES = Object.freeze({
  counting: { file: 'OvertimeCounting.png', color: '#E5533D' },
  idle: { file: 'OvertimeIdle.png', color: '#9AA4B2' },
});
const trayImageCache = new Map();

let trayAccent = null;
let overtimeAccent = null;
let trayIconSetCount = 0;

function cachedTrayImage(file, template = false) {
  const key = `${template ? 'template' : 'color'}:${file}`;
  if (trayImageCache.has(key)) return trayImageCache.get(key);
  const iconPath = path.join(__dirname, 'assets', file);
  const image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) {
    log(`菜单栏图标缺失或无法读取：${iconPath}`);
  } else {
    image.setTemplateImage(template);
  }
  trayImageCache.set(key, image);
  return image;
}

function trayAccentStyle(state) {
  return TRAY_ACCENT_STYLES[state] || TRAY_ACCENT_STYLES.work;
}

function overtimeAccentStyle(state) {
  return OVERTIME_ACCENT_STYLES[state] || OVERTIME_ACCENT_STYLES.idle;
}

function overtimeAccentFor(state) {
  return state === 'counting' ? 'counting' : 'idle';
}

/** 只在状态变化时换主托盘图标；返回当前生效的状态。 */
function applyTrayAccent(state) {
  if (!tray) return null;
  if (state === trayAccent) return trayAccent;
  const style = trayAccentStyle(state);
  let image = cachedTrayImage(style.file, false);
  let fallback = false;
  if (image.isEmpty()) {
    image = cachedTrayImage('SunClockTemplate.png', true);
    fallback = true;
  }
  try {
    tray.setImage(image);
    trayAccent = state;
    trayIconSetCount += 1;
    log(
      `tray icon state=${state} color=${style.color}${fallback ? ' fallback=template' : ''}`,
    );
  } catch (error) {
    // 极少数情况下 Electron/Tray 拒绝彩色图：回退到模板图并记录，避免空白。
    log(`tray.setImage 失败 state=${state}：${error.message}`);
    try {
      tray.setImage(cachedTrayImage('SunClockTemplate.png', true));
      trayAccent = state;
      trayIconSetCount += 1;
      log(`tray icon state=${state} color=${style.color} fallback=template reason=setImage-error`);
    } catch (fallbackError) {
      log(`tray icon fallback 失败 state=${state}：${fallbackError.message}`);
    }
  }
  return trayAccent;
}

/** 只在加班计时状态变化时换第二个托盘图标。 */
function applyOvertimeAccent(state) {
  if (!overtimeTray) return null;
  const desired = overtimeAccentFor(state);
  if (desired === overtimeAccent) return overtimeAccent;
  const style = overtimeAccentStyle(desired);
  let image = cachedTrayImage(style.file, false);
  let fallback = false;
  if (image.isEmpty()) {
    image = cachedTrayImage('OvertimeTemplate.png', true);
    fallback = true;
  }
  try {
    overtimeTray.setImage(image);
    overtimeAccent = desired;
    log(
      `overtime icon state=${desired} color=${style.color}${fallback ? ' fallback=template' : ''}`,
    );
  } catch (error) {
    log(`overtimeTray.setImage 失败 state=${desired}：${error.message}`);
    try {
      overtimeTray.setImage(cachedTrayImage('OvertimeTemplate.png', true));
      overtimeAccent = desired;
      log(`overtime icon state=${desired} color=${style.color} fallback=template reason=setImage-error`);
    } catch (fallbackError) {
      log(`overtime icon fallback 失败 state=${desired}：${fallbackError.message}`);
    }
  }
  return overtimeAccent;
}

// ---------------------------------------------------------------------------
// 托盘标题 / 通知
// ---------------------------------------------------------------------------
function currentStatus(now = new Date()) {
  return computeStatus(settings, now);
}

function tooltipFor(status) {
  if (status.state === 'rest') return `${APP_NAME} · ${status.title}`;
  if (status.state === 'lunch') {
    return `${APP_NAME} · ${status.title}（${settings.workStart}–${settings.workEnd}）`;
  }
  if (status.state === 'done') {
    return `${APP_NAME} · 已下班（${settings.workEnd}）`;
  }
  return `${APP_NAME} · ${status.title}（${settings.workStart}–${settings.workEnd}）`;
}

function applyTrayTitle(status = currentStatus(), now = new Date()) {
  if (!tray) return status;
  tray.setTitle(` ${status.title}`, { fontType: 'monospacedDigit' });
  tray.setToolTip(tooltipFor(status));
  applyTrayAccent(trayAccentState(settings, now));
  return status;
}

/** 生成给渲染进程/自检用的设置副本（避免跨进程共享嵌套引用）。 */
function settingsForRenderer() {
  return {
    ...settings,
    customRestDays: [...settings.customRestDays],
    alternating: { ...settings.alternating },
    weeklyPlan: { ...settings.weeklyPlan },
    lunch: { ...settings.lunch },
    overtime: { ...settings.overtime },
    water: { ...settings.water },
    rest: { ...settings.rest },
    appearance: { ...settings.appearance },
  };
}

/**
 * 加班托盘：enabled=true 时始终存在，否则销毁。
 * 标题每秒随 tick 重算：`暂无加班` 或 `加班时长:HH:MM:SS`。
 */
function applyOvertime(now = new Date()) {
  const overtime = computeOvertime(settings, now);

  if (!overtime.enabled) {
    if (overtimeTray) {
      overtimeTray.destroy();
      overtimeTray = null;
      overtimeAccent = null;
      previousOvertimeState = null;
      log('overtime tray removed (overtime disabled)');
    }
    return overtime;
  }

  if (!overtimeTray) {
    const desired = overtimeAccentFor(overtime.state);
    const style = overtimeAccentStyle(desired);
    let icon = cachedTrayImage(style.file, false);
    let fallback = false;
    if (icon.isEmpty()) {
      icon = cachedTrayImage('OvertimeTemplate.png', true);
      fallback = true;
    }
    overtimeTray = new Tray(icon);
    overtimeTray.on('click', showOvertimeMenu);
    overtimeTray.on('right-click', showOvertimeMenu);
    overtimeAccent = desired;
    log(
      `overtime icon state=${desired} color=${style.color}${fallback ? ' fallback=template' : ''}`,
    );
    log(
      `overtime tray created, title=${overtime.title} start=${settings.overtime.start} enabled=true`,
    );
  } else {
    applyOvertimeAccent(overtime.state);
  }

  overtimeTray.setTitle(` ${overtime.title}`, { fontType: 'monospacedDigit' });
  overtimeTray.setToolTip(`${APP_NAME} · ${overtime.header}`);
  return overtime;
}

function buildOvertimeMenu() {
  const overtime = computeOvertime(settings, new Date());
  return Menu.buildFromTemplate([
    { label: overtime.title, enabled: false },
    { label: `工作日 ${settings.overtime.start} 起算`, enabled: false },
    { type: 'separator' },
    {
      label: '设置…',
      accelerator: 'CommandOrControl+,',
      click: () => openSettingsWindow(),
    },
    { type: 'separator' },
    {
      label: '退出',
      accelerator: 'CommandOrControl+Q',
      click: () => app.quit(),
    },
  ]);
}

function showOvertimeMenu() {
  if (!overtimeTray) return;
  const now = Date.now();
  if (now - lastOvertimeMenuOpenedAt < 250) return;
  lastOvertimeMenuOpenedAt = now;
  overtimeTray.popUpContextMenu(buildOvertimeMenu());
}

/**
 * 月排班快捷切换：写入当前周（周一为键）并立即落盘，刷新托盘/菜单。
 * 与设置窗口保存走同一条 persistSettings 路径。
 */
function setWeekPlan(plan) {
  if (plan !== 'double' && plan !== 'single') return null;
  const now = new Date();
  const key = mondayKey(now);
  settings = sanitizeSettings(
    {
      ...settings,
      weeklyPlan: { ...settings.weeklyPlan, [key]: plan },
    },
    now,
  );
  try {
    persistSettings(settings);
    log(`weekly plan saved: ${key}=${plan}`);
  } catch (error) {
    log(`保存本周休息安排失败：${error.message}`);
  }
  previousStatus = currentStatus(now);
  applyTrayTitle(previousStatus);
  applyOvertime(now);
  return settings.weeklyPlan[key];
}

/**
 * 发送一条去重后的通知。type = 'before' | 'end'。
 * 同一天同一类型最多一次；notify-state.json 在重启后仍然生效。
 */
function sendNotification(type, now, options) {
  const key = dayKey(now);
  if (notifyState.day === key && notifyState[type]) {
    log(`通知已发送过，跳过 type=${type} day=${key}`);
    return false;
  }
  if (!Notification.isSupported()) {
    log('系统不支持通知，跳过提醒。');
    return false;
  }
  try {
    const notification = new Notification({
      title: options.title,
      body: options.body,
      silent: false,
    });
    notification.on('failed', (_event, error) => log(`通知发送失败：${error}`));
    notification.show();
    markNotified(key, type);
    log(`已发送通知 type=${type} day=${key} title=${options.title}`);
    return true;
  } catch (error) {
    log(`通知异常：${error.message}`);
    return false;
  }
}

function maybeNotify(now, status, previous) {
  const events = notificationEvents(settings, previous, status);
  if (!events.before && !events.end) return;

  if (events.before) {
    const minutes = settings.notifyBeforeMinutes;
    sendNotification('before', now, {
      title: '准备下班',
      body: `还有 ${minutes} 分钟下班，可以准备收尾了。`,
    });
  }
  if (events.end) {
    sendNotification('end', now, {
      title: '下班时间到',
      body: '下班时间到，今天辛苦了。',
    });
  }
}

function tick() {
  if (!tray) return;
  const now = new Date();
  const status = applyTrayTitle(currentStatus(now), now);
  const overtime = applyOvertime(now);

  if (overtime.enabled) {
    if (previousOvertimeState !== overtime.state) {
      log(
        `overtime state ${previousOvertimeState || 'start'} -> ${overtime.state} title=${overtime.title}`,
      );
    }
    previousOvertimeState = overtime.state;
  } else {
    previousOvertimeState = null;
  }

  if (previousStatus) {
    if (status.state !== previousStatus.state) {
      log(`state ${previousStatus.state} -> ${status.state} title=${status.title}`);
    }
    maybeNotify(now, status, previousStatus);
  }
  previousStatus = status;

  // 喝水 / 休息提醒：复用同一个 1s tick，不额外创建定时器。
  checkReminders(now);
  // 跟随日出日落 / 跟随系统时，主题跨过阈值会推送给设置窗口。
  publishTheme();

  const minute = now.getMinutes();
  if (minute !== lastLoggedMinute) {
    lastLoggedMinute = minute;
    log(
      `tick ${now.toLocaleString('zh-CN', { hour12: false })} title=${status.title} overtime=${overtime.title}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 菜单
// ---------------------------------------------------------------------------
function isLoginItemEnabled() {
  try {
    return Boolean(app.getLoginItemSettings().openAtLogin);
  } catch (error) {
    log(`读取开机启动状态失败：${error.message}`);
    return Boolean(settings.launchAtLogin);
  }
}

function setLaunchAtLogin(enabled) {
  settings = sanitizeSettings({ ...settings, launchAtLogin: enabled }, new Date());
  try {
    persistSettings(settings);
  } catch (error) {
    log(`保存开机启动偏好失败：${error.message}`);
  }
  try {
    app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: false });
    log(`开机启动已设置为 ${enabled}`);
  } catch (error) {
    log(`设置开机启动失败：${error.message}`);
  }
  applyTrayTitle();
}

function buildMenu() {
  const now = new Date();
  const status = currentStatus(now);
  const template = [
    { label: status.header, enabled: false },
    { label: `上班 ${settings.workStart} · 下班 ${settings.workEnd}`, enabled: false },
    { label: status.restDescription, enabled: false },
  ];

  if (status.restMode === 'monthly') {
    const plan = resolveWeekPlan(settings, now);
    template.push({
      label: '本周休息安排',
      submenu: [
        {
          label: '双休',
          type: 'radio',
          checked: plan === 'double',
          click: () => setWeekPlan('double'),
        },
        {
          label: '单休',
          type: 'radio',
          checked: plan === 'single',
          click: () => setWeekPlan('single'),
        },
      ],
    });
  }

  if (status.lunch.enabled) {
    if (status.isWorkday && status.lunch.startRemainingMs !== null) {
      template.push({
        label: `距午休 ${formatDuration(status.lunch.startRemainingMs)}`,
        enabled: false,
      });
    }
    template.push({
      label: `午休 ${status.lunch.start}–${status.lunch.end}`,
      enabled: false,
    });
  }

  const overtime = computeOvertime(settings, now);
  template.push({ label: overtime.header, enabled: false });

  template.push(
    { type: 'separator' },
    { label: '设置…', accelerator: 'CommandOrControl+,', click: () => openSettingsWindow() },
    {
      label: '开机启动',
      type: 'checkbox',
      checked: isLoginItemEnabled(),
      click: (item) => setLaunchAtLogin(Boolean(item.checked)),
    },
    { type: 'separator' },
    { label: '退出', accelerator: 'CommandOrControl+Q', click: () => app.quit() },
  );

  return Menu.buildFromTemplate(template);
}

function showMenu() {
  if (!tray) return;
  const now = Date.now();
  if (now - lastMenuOpenedAt < 250) return; // 防止 click / right-click 重复弹出
  lastMenuOpenedAt = now;
  tray.popUpContextMenu(buildMenu());
}

// ---------------------------------------------------------------------------
// v1.4.0：GitHub Release 更新检查（主进程，异步、带超时、绝不崩溃）
// ---------------------------------------------------------------------------
const UPDATE_TIMEOUT_MS = 8000;
const UPDATE_MAX_BODY_BYTES = 2000000;

function githubGetJson(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    let request;
    try {
      request = https.get(
        url,
        {
          headers: {
            'User-Agent': `OffWorkCountdown/${app.getVersion()}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          timeout: UPDATE_TIMEOUT_MS,
        },
        (response) => {
          const status = response.statusCode || 0;
          const location = response.headers.location;
          if (
            [301, 302, 307, 308].includes(status) &&
            location &&
            redirects < 3
          ) {
            response.resume();
            resolve(githubGetJson(location, redirects + 1));
            return;
          }
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => {
            body += chunk;
            if (body.length > UPDATE_MAX_BODY_BYTES) {
              request.destroy(new Error('response too large'));
            }
          });
          response.on('end', () => resolve({ statusCode: status, body }));
        },
      );
    } catch (error) {
      reject(error);
      return;
    }
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
  });
}

/**
 * 检查 GitHub 最新 Release。永远返回
 * { status: 'latest'|'update'|'error', currentVersion, latestVersion, url, message }，
 * 不抛异常、不阻塞界面。自检 / OFFLOW_OFFLINE=1 时优雅禁用。
 */
async function checkForUpdates(repoOverride) {
  const currentVersion = app.getVersion();
  if (SELFTEST || process.env.OFFWORK_OFFLINE === '1') {
    log('update check disabled (selftest/offline)');
    return updateErrorResult('disabled', null, currentVersion);
  }
  const repo =
    normalizeUpdateRepo(repoOverride) ||
    normalizeUpdateRepo(settings.updateRepo) ||
    DEFAULT_UPDATE_REPO;
  if (!repo) return updateErrorResult('norepo', null, currentVersion);

  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  log(`update check: repo=${repo} current=${currentVersion}`);
  let response;
  try {
    response = await githubGetJson(url);
  } catch (error) {
    const kind = /timeout/i.test(String(error && error.message)) ? 'timeout' : 'network';
    log(`update check network error: ${error && error.message}`);
    return updateErrorResult(kind, error && error.message, currentVersion);
  }

  if (response.statusCode === 404) {
    log('update check: 404 no releases');
    return updateErrorResult('notfound', 404, currentVersion);
  }
  if (response.statusCode === 403) {
    log('update check: 403 rate limited');
    return updateErrorResult('ratelimit', 403, currentVersion);
  }
  if (response.statusCode !== 200) {
    log(`update check: HTTP ${response.statusCode}`);
    return updateErrorResult('http', response.statusCode, currentVersion);
  }

  let release;
  try {
    release = JSON.parse(response.body);
  } catch (error) {
    log(`update check: malformed JSON ${error.message}`);
    return updateErrorResult('malformed', null, currentVersion);
  }
  const result = updateResultFromRelease(release, currentVersion, repo);
  log(
    `update check result: ${result.status} current=${result.currentVersion} latest=${result.latestVersion} url=${result.url}`,
  );
  return result;
}

function isAllowedReleaseUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      (url.hostname === 'github.com' || url.hostname === 'www.github.com')
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 设置窗口
// ---------------------------------------------------------------------------
function windowForEvent(event) {
  return BrowserWindow.fromWebContents(event.sender);
}

function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    app.focus({ steal: true });
    return;
  }

  // 640×760，并按屏幕可用区域收敛（小屏上不会超出屏幕）。
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.max(320, Math.min(640, workArea.width - 40));
  const height = Math.max(400, Math.min(760, workArea.height - 40));
  const theme = resolvedTheme();

  settingsWindow = new BrowserWindow({
    width,
    height,
    useContentSize: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: 'WORK OR RUN',
    backgroundColor: theme === 'dark' ? '#17171a' : '#f2f2f5',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
  settingsWindow.once('ready-to-show', () => {
    if (!settingsWindow) return;
    settingsWindow.show();
    settingsWindow.focus();
    app.focus({ steal: true });
    publishTheme(true);
  });
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
  log(`settings window opened size=${width}x${height} theme=${theme}`);
}

ipcMain.handle('settings:load', () => {
  const now = new Date();
  return {
    settings: settingsForRenderer(),
    meta: {
      userDataPath: USER_DATA,
      appName: APP_NAME,
      version: app.getVersion(),
      author: '黄溢球',
      today: dayKey(now),
      currentWeekMonday: mondayKey(now),
      currentWeekPlan: resolveWeekPlan(settings, now),
      alternatingIsDoubleThisWeek: alternatingWeekIsDouble(
        settings.alternating,
        now,
      ),
      theme: resolvedTheme(now),
      systemPrefersDark: nativeTheme.shouldUseDarkColors,
      defaultUpdateRepo: DEFAULT_UPDATE_REPO,
    },
  };
});

ipcMain.handle('settings:preview-theme', (_event, appearance) => {
  const theme = resolveTheme(
    appearance,
    new Date(),
    nativeTheme.shouldUseDarkColors,
  );
  return { ok: true, theme };
});

ipcMain.handle('settings:save', (event, payload) => {
  const now = new Date();
  const check = validateSettings(payload, now);
  if (!check.ok) {
    log(`settings save rejected: ${check.error}`);
    return { ok: false, error: check.error };
  }

  // 设置窗口不管理开机启动与 lastSeenVersion，保留原值。
  settings = sanitizeSettings(
    {
      ...check.settings,
      launchAtLogin: settings.launchAtLogin,
      lastSeenVersion: settings.lastSeenVersion,
    },
    now,
  );

  try {
    persistSettings(settings);
  } catch (error) {
    log(`保存设置失败：${error.message}`);
    return { ok: false, error: `保存失败：${error.message}` };
  }

  log(`settings saved: ${JSON.stringify(settings)}`);
  // 保存后重置对比基线，避免因修改下班时间而误触发“提前提醒”。
  previousStatus = currentStatus(now);
  applyTrayTitle(previousStatus);
  const overtime = applyOvertime(now);
  previousOvertimeState = overtime.state;
  // 提醒间隔基线随设置变化重置（避免刚改完就立刻提醒）。
  resetReminderBaselines(now, 'settings saved');
  // 主题可能变化：立即推送给打开着的设置窗口。
  publishTheme(true);
  const win = windowForEvent(event);
  if (win && !win.isDestroyed()) {
    win.setTitle('WORK OR RUN');
    win.setBackgroundColor(resolvedTheme(now) === 'dark' ? '#17171a' : '#f2f2f5');
  }
  return { ok: true, settings: settingsForRenderer() };
});

ipcMain.handle('settings:cancel', (event) => {
  const win = windowForEvent(event);
  if (win && !win.isDestroyed()) win.close();
  return { ok: true };
});

ipcMain.handle('settings:close', (event) => {
  const win = windowForEvent(event);
  if (win && !win.isDestroyed()) win.close();
  return { ok: true };
});

// --- 喝水记录 IPC ----------------------------------------------------------
ipcMain.handle('water:get', () => ({ ok: true, state: waterSnapshot(new Date()) }));

ipcMain.handle('water:record', (_event, ml) => {
  const amount = Number(ml);
  if (
    !Number.isInteger(amount) ||
    amount < WATER_AMOUNT_MIN ||
    amount > WATER_AMOUNT_MAX
  ) {
    return {
      ok: false,
      error: `喝水量必须是 ${WATER_AMOUNT_MIN}–${WATER_AMOUNT_MAX} 的整数（ml）。`,
    };
  }
  const state = recordWater(amount, new Date());
  if (!state) return { ok: false, error: '记录喝水失败，请重试。' };
  return { ok: true, state };
});

ipcMain.handle('water:clear', () => ({
  ok: true,
  state: clearWater(new Date()),
}));

// --- 更新检查 IPC ----------------------------------------------------------
ipcMain.handle('update:check', () => checkForUpdates());

ipcMain.handle('update:open', async (_event, url) => {
  if (!isAllowedReleaseUrl(url)) {
    log(`update:open 拒绝非 GitHub URL：${url}`);
    return { ok: false, error: '只能打开 GitHub 的发布页面。' };
  }
  try {
    await shell.openExternal(url);
    log(`update:open ${url}`);
    return { ok: true };
  } catch (error) {
    log(`打开 Release 页面失败：${error.message}`);
    return { ok: false, error: `打开链接失败：${error.message}` };
  }
});

// ---------------------------------------------------------------------------
// 应用菜单（LSUIElement 下通常不显示，但避免继承 DeepSeek Harness 的菜单）
// ---------------------------------------------------------------------------
function buildApplicationMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: APP_NAME,
        submenu: [
          { label: '设置…', accelerator: 'CommandOrControl+,', click: () => openSettingsWindow() },
          { type: 'separator' },
          { role: 'hide', label: '隐藏' },
          { role: 'hideOthers', label: '隐藏其他' },
          { role: 'unhide', label: '全部显示' },
          { type: 'separator' },
          { label: '退出', accelerator: 'CommandOrControl+Q', click: () => app.quit() },
        ],
      },
      { role: 'editMenu', label: '编辑' },
      { role: 'windowMenu', label: '窗口' },
    ]),
  );
}

// ---------------------------------------------------------------------------
// 无界面自检（仅在 OFFWORK_SELFTEST=1 / --selftest 时运行）。
// 使用 /tmp/offwork-selftest-<pid> 作为隔离 userData，绝不写真实设置。
// ---------------------------------------------------------------------------
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function settingsDefaultsForSelfTest(now) {
  return {
    workStart: '09:00',
    workEnd: '18:00',
    restMode: 'double',
    customRestDays: [0, 6],
    alternating: { anchorDate: mondayKey(now), anchorIsDouble: true },
    weeklyPlan: {},
    lunch: { enabled: true, start: '12:00', end: '13:00' },
    overtime: { enabled: true, start: '18:00' },
    notifyAtEnd: true,
    notifyBeforeMinutes: 0,
    water: {
      enabled: true,
      intervalMinutes: 45,
      goalMl: 2000,
      cupMl: 250,
      workHoursOnly: true,
    },
    rest: {
      enabled: true,
      intervalMinutes: 45,
      durationMinutes: 5,
      workHoursOnly: true,
    },
    appearance: {
      themeMode: 'system',
      accent: '#F5A65B',
      sunrise: '06:30',
      sunset: '18:00',
    },
    updateRepo: 'BALLBALLUUUUU/WORK-OR-RUN',
  };
}

async function runSelfTest() {
  const results = [];
  const check = (name, condition, detail) => {
    results.push({ name, ok: Boolean(condition) });
    log(`selftest ${condition ? 'ok' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`);
  };

  const makeWindow = () =>
    new BrowserWindow({
      width: 640,
      height: 760,
      useContentSize: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

  try {
    // --- 0. 隔离性 ---
    check(
      '自检使用 /tmp 临时 userData',
      USER_DATA !== REAL_USER_DATA && USER_DATA.startsWith('/tmp/offwork-selftest-'),
      USER_DATA,
    );
    check('临时 settings.json 已创建', fs.existsSync(SETTINGS_FILE), SETTINGS_FILE);

    // --- 0.5 彩色菜单栏图标：资源 / 状态映射 / 主托盘切换 ---
    const accentFiles = [
      ...Object.entries(TRAY_ACCENT_STYLES).map(([state, style]) => [state, style.file]),
      ...Object.entries(OVERTIME_ACCENT_STYLES).map(([state, style]) => [state, style.file]),
    ];
    const accentDetails = accentFiles.map(([state, file]) => {
      const base = path.join(__dirname, 'assets', file);
      const retina = base.replace(/\.png$/, '@2x.png');
      const image = cachedTrayImage(file, false);
      return {
        state,
        file,
        exists: fs.existsSync(base) && fs.existsSync(retina),
        empty: image.isEmpty(),
        template: image.isEmpty() ? null : image.isTemplateImage(),
        size: image.isEmpty()
          ? null
          : `${image.getSize().width}x${image.getSize().height}`,
      };
    });
    check(
      '彩色菜单栏图标齐全（16/32@2x，加载为非模板）',
      accentDetails.every(
        (item) =>
          item.exists &&
          !item.empty &&
          item.template === false &&
          item.size === '16x16',
      ),
      JSON.stringify(accentDetails),
    );

    // --- 0.6 P1：图标 alpha bbox 居中 / 视觉重量（用 nativeImage 解码 PNG） ---
    const iconPixelMetrics = (file) => {
      const image = nativeImage.createFromPath(path.join(__dirname, 'assets', file));
      if (image.isEmpty()) return null;
      // 注意：macOS 上 @2x 文件会被当成 scaleFactor=2 的表示，getSize() 返回逻辑
      // 尺寸 16x16，而 toBitmap() 返回真实的 32x32 像素。这里按 bitmap 长度反推
      // 实际像素边长，避免把 32px 图标误判成 16px。
      const bitmap = image.toBitmap();
      const pixels = bitmap.length / 4;
      const side = Math.round(Math.sqrt(pixels));
      if (side * side !== pixels) return null;
      let x0 = side;
      let y0 = side;
      let x1 = -1;
      let y1 = -1;
      let mass = 0;
      for (let y = 0; y < side; y += 1) {
        for (let x = 0; x < side; x += 1) {
          const alpha = bitmap[(y * side + x) * 4 + 3];
          if (alpha >= 8) {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
          if (alpha >= 128) mass += 1;
        }
      }
      if (x1 < 0) return null;
      return {
        size: { width: side, height: side },
        center: [(x0 + x1) / 2, (y0 + y1) / 2],
        extent: [x1 - x0 + 1, y1 - y0 + 1],
        mass,
      };
    };
    const centerWithin = (metrics, px) =>
      Boolean(metrics) &&
      metrics.size.width === px &&
      Math.abs(metrics.center[0] - (px - 1) / 2) <= 1 &&
      Math.abs(metrics.center[1] - (px - 1) / 2) <= 1;
    const lunch16 = iconPixelMetrics('SunClockLunch.png');
    const lunch32 = iconPixelMetrics('SunClockLunch@2x.png');
    check(
      'P1 午休图标 alpha bbox 中心在画布中心 ±1px（16/32）',
      centerWithin(lunch16, 16) && centerWithin(lunch32, 32),
      `lunch16=${JSON.stringify(lunch16)} lunch32=${JSON.stringify(lunch32)}`,
    );
    const ref16 = iconPixelMetrics('OvertimeTemplate.png');
    const ref32 = iconPixelMetrics('OvertimeTemplate@2x.png');
    const sunStateFiles = [
      ['SunClockWork.png', 16, ref16],
      ['SunClockLunch.png', 16, ref16],
      ['SunClockOvertime.png', 16, ref16],
      ['SunClockRest.png', 16, ref16],
      ['SunClockWork@2x.png', 32, ref32],
      ['SunClockLunch@2x.png', 32, ref32],
      ['SunClockOvertime@2x.png', 32, ref32],
      ['SunClockRest@2x.png', 32, ref32],
    ];
    const sunMetrics = sunStateFiles.map(([file, px, reference]) => {
      const metrics = iconPixelMetrics(file);
      const massRatio = reference ? metrics.mass / reference.mass : 0;
      const extentRatio = reference
        ? Math.max(...metrics.extent) / Math.max(...reference.extent)
        : 0;
      return {
        file,
        px,
        centered: centerWithin(metrics, px),
        massRatio,
        extentRatio,
        metrics,
      };
    });
    check(
      'P1 四个主状态图标 bbox 居中且质量/跨度与月牙图标相当',
      sunMetrics.every(
        (item) =>
          item.centered &&
          item.massRatio >= 0.6 &&
          item.massRatio <= 1.6 &&
          item.extentRatio >= 0.8 &&
          item.extentRatio <= 1.35,
      ),
      JSON.stringify(
        sunMetrics.map((item) => ({
          file: item.file,
          centered: item.centered,
          massRatio: Number(item.massRatio.toFixed(2)),
          extentRatio: Number(item.extentRatio.toFixed(2)),
          bboxCenter: item.metrics.center,
        })),
      ),
    );

    const mappingBase = sanitizeSettings(
      {
        ...settingsDefaultsForSelfTest(new Date()),
        workEnd: '19:00',
        restMode: 'double',
        lunch: { enabled: true, start: '12:00', end: '13:00' },
        overtime: { enabled: true, start: '19:00' },
      },
      new Date(2026, 10, 9, 0, 0, 0),
    );
    const accentColorAt = (overrides, at) =>
      trayAccentStyle(trayAccentState({ ...mappingBase, ...overrides }, at)).color;
    const mapProbe = {
      work: accentColorAt({}, new Date(2026, 10, 9, 10, 0, 0)),
      lunch: accentColorAt({}, new Date(2026, 10, 9, 12, 30, 0)),
      overtime: accentColorAt({}, new Date(2026, 10, 9, 19, 30, 0)),
      rest: accentColorAt({}, new Date(2026, 10, 14, 10, 0, 0)),
      overtimeDisabled: accentColorAt(
        { overtime: { enabled: false, start: '19:00' } },
        new Date(2026, 10, 9, 20, 0, 0),
      ),
      afterWorkBeforeOvertime: accentColorAt({}, new Date(2026, 10, 9, 18, 30, 0)),
    };
    check(
      '状态→图标颜色映射符合预期',
      mapProbe.work === '#F5A65B' &&
        mapProbe.lunch === '#8FD19E' &&
        mapProbe.overtime === '#E5533D' &&
        mapProbe.rest === '#9AA4B2' &&
        mapProbe.overtimeDisabled === '#F5A65B' &&
        mapProbe.afterWorkBeforeOvertime === '#F5A65B',
      JSON.stringify(mapProbe),
    );

    // 主托盘：两个不同状态各 setImage 一次，重复状态不重复 setImage。
    const liveAccent = trayAccentState(settings, new Date());
    const probeA = liveAccent === 'work' ? 'rest' : 'work';
    const probeB = probeA === 'work' ? 'rest' : 'work';
    const countBefore = trayIconSetCount;
    applyTrayAccent(probeA);
    const countA = trayIconSetCount;
    const stateA = trayAccent;
    applyTrayAccent(probeB);
    const countB = trayIconSetCount;
    applyTrayAccent(probeB);
    const countRepeat = trayIconSetCount;
    applyTrayAccent(liveAccent);
    const countRestored = trayIconSetCount;
    const expectedRestored = liveAccent === probeB ? countB : countB + 1;
    check(
      '主托盘图标随状态切换（相同状态不重复 setImage）',
      stateA === probeA &&
        trayAccent === liveAccent &&
        countA === countBefore + 1 &&
        countB === countA + 1 &&
        countRepeat === countB &&
        countRestored === expectedRestored,
      `states=${probeA}->${probeB}->${liveAccent} counts=${countBefore},${countA},${countB},${countRepeat},${countRestored}`,
    );

    // --- 1. 菜单结构 ---
    const menu = buildMenu();
    const labels = menu.items.map((item) => item.label);
    check(
      '菜单包含 设置/开机启动/退出',
      labels.includes('设置…') && labels.includes('开机启动') && labels.includes('退出'),
      JSON.stringify(labels),
    );
    check(
      '菜单头部为实时状态',
      /距下班|午休中|已下班|周末愉快|今天休息/.test(menu.items[0].label || ''),
      menu.items[0].label,
    );
    const statusAtMenu = currentStatus();
    check(
      '菜单包含休息日模式说明',
      labels.includes(statusAtMenu.restDescription),
      statusAtMenu.restDescription,
    );
    check(
      '菜单显示当前班次',
      labels.some(
        (label) =>
          typeof label === 'string' &&
          label.includes(settings.workStart) &&
          label.includes(settings.workEnd),
      ),
      JSON.stringify(labels),
    );
    check(
      '菜单显示午休时间段',
      !settings.lunch.enabled ||
        labels.includes(`午休 ${settings.lunch.start}–${settings.lunch.end}`),
      JSON.stringify(labels),
    );
    const loginItem = menu.items.find((item) => item.label === '开机启动');
    check(
      '开机启动是勾选型菜单项',
      Boolean(loginItem) && loginItem.type === 'checkbox',
      String(loginItem && loginItem.type),
    );

    // --- 2. 窗口 A：默认值渲染 / 模式切换 / 非法输入 ---
    const winA = makeWindow();
    await winA.loadFile(path.join(__dirname, 'settings.html'));
    await delay(400);

    const ui = await winA.webContents.executeJavaScript(
      `({
        hasApi: typeof window.offwork === 'object',
        lang: document.documentElement.lang,
        title: document.title,
        tabs: Array.from(document.querySelectorAll('.tab')).map((el) => el.textContent.trim()).join(','),
        activeTab: document.querySelector('.tab[aria-selected="true"]').dataset.tab,
        visiblePanels: Array.from(document.querySelectorAll('.panel')).filter((el) => !el.hidden).map((el) => el.dataset.panel).join(','),
        theme: document.documentElement.dataset.theme,
        start: document.getElementById('workStart').value,
        end: document.getElementById('workEnd').value,
        restMode: document.getElementById('restMode').value,
        restModeOptions: Array.from(document.getElementById('restMode').options).map((o) => o.value).join(','),
        altHidden: document.getElementById('alternatingRow').hidden,
        customHidden: document.getElementById('customRow').hidden,
        monthlyHidden: document.getElementById('monthlyRow').hidden,
        dayCount: document.querySelectorAll('input[name="customRestDay"]').length,
        dayOrder: Array.from(document.querySelectorAll('input[name="customRestDay"]')).map((el) => el.value).join(','),
        checkedDays: Array.from(document.querySelectorAll('input[name="customRestDay"]:checked')).map((el) => Number(el.value)).sort((a, b) => a - b),
        lunchEnabled: document.getElementById('lunchEnabled').checked,
        lunchStart: document.getElementById('lunchStart').value,
        lunchEnd: document.getElementById('lunchEnd').value,
        lunchDisabled: document.getElementById('lunchStart').disabled,
        overtimeEnabled: document.getElementById('overtimeEnabled').checked,
        overtimeStart: document.getElementById('overtimeStart').value,
        overtimeStartDisabled: document.getElementById('overtimeStart').disabled,
        notifyAtEnd: document.getElementById('notifyAtEnd').checked,
        notifyBefore: document.getElementById('notifyBeforeMinutes').value,
        waterEnabled: document.getElementById('waterEnabled').checked,
        waterInterval: document.getElementById('waterInterval').value,
        waterGoal: document.getElementById('waterGoal').value,
        waterCup: document.getElementById('waterCup').value,
        waterWorkHoursOnly: document.getElementById('waterWorkHoursOnly').checked,
        restEnabled: document.getElementById('restEnabled').checked,
        restInterval: document.getElementById('restInterval').value,
        restDuration: document.getElementById('restDuration').value,
        restWorkHoursOnly: document.getElementById('restWorkHoursOnly').checked,
        themeMode: (document.querySelector('input[name="themeMode"]:checked') || {}).value,
        sunriseHidden: document.getElementById('sunriseRow').hidden,
        accentValue: document.getElementById('accentCustom').value.toUpperCase(),
        accentVar: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().toUpperCase(),
        updateRepo: document.getElementById('updateRepo').value,
        version: document.getElementById('metaVersion').textContent,
        settingsVersion: document.getElementById('settingsVersion').textContent,
        waterPercent: document.getElementById('waterPercent').textContent,
        waterTotal: document.getElementById('waterTotal').textContent,
      })`,
    );
    check('preload 暴露 offwork API', ui.hasApi);
    check('设置窗口语言为 zh-CN', ui.lang === 'zh-CN', ui.lang);
    check('窗口标题为 WORK OR RUN', ui.title === 'WORK OR RUN', ui.title);
    check(
      '设置窗口正确渲染默认值',
      ui.start === '09:00' &&
        ui.end === '18:00' &&
        ui.restMode === 'double' &&
        ui.lunchEnabled === true &&
        ui.lunchStart === '12:00' &&
        ui.lunchEnd === '13:00' &&
        ui.overtimeEnabled === true &&
        ui.overtimeStart === '18:00' &&
        ui.overtimeStartDisabled === false &&
        ui.notifyAtEnd === true &&
        ui.notifyBefore === '0',
      JSON.stringify(ui),
    );
    check(
      '自定义休息日有 7 个复选框（周一…周日）',
      ui.dayCount === 7 && ui.dayOrder === '1,2,3,4,5,6,0',
      `${ui.dayCount} / ${ui.dayOrder}`,
    );
    check(
      '双休模式下隐藏大小休/自定义/月排班行',
      ui.altHidden === true && ui.customHidden === true && ui.monthlyHidden === true,
      JSON.stringify(ui),
    );
    check(
      '休息模式包含 double/single/alternating/monthly/custom',
      ui.restModeOptions === 'double,single,alternating,monthly,custom',
      ui.restModeOptions,
    );
    check(
      '五个标签页（倒计时/喝水提醒/休息提醒/设置/关于）',
      ui.tabs === '倒计时,喝水提醒,休息提醒,设置,关于' &&
        ui.activeTab === 'countdown' &&
        ui.visiblePanels === 'countdown',
      `${ui.tabs} active=${ui.activeTab} visible=${ui.visiblePanels}`,
    );
    check('版本号显示为 v1.4.0', ui.version.trim() === 'v1.4.0', ui.version);
    check(
      '设置/关于标签页中的当前版本均为 v1.4.0',
      ui.settingsVersion.trim() === 'v1.4.0',
      `${ui.settingsVersion} / ${ui.version}`,
    );
    check(
      '喝水提醒默认值（启用/45 分钟/2000ml/250ml/仅工作时间）',
      ui.waterEnabled === true &&
        ui.waterInterval === '45' &&
        ui.waterGoal === '2000' &&
        ui.waterCup === '250' &&
        ui.waterWorkHoursOnly === true,
      JSON.stringify({
        enabled: ui.waterEnabled,
        interval: ui.waterInterval,
        goal: ui.waterGoal,
        cup: ui.waterCup,
        workHoursOnly: ui.waterWorkHoursOnly,
      }),
    );
    check(
      '休息提醒默认值（启用/45 分钟/5 分钟/仅工作时间）',
      ui.restEnabled === true &&
        ui.restInterval === '45' &&
        ui.restDuration === '5' &&
        ui.restWorkHoursOnly === true,
      JSON.stringify({
        enabled: ui.restEnabled,
        interval: ui.restInterval,
        duration: ui.restDuration,
        workHoursOnly: ui.restWorkHoursOnly,
      }),
    );
    check(
      '外观默认值（跟随系统 / #F5A65B / 日出日落隐藏）',
      ui.themeMode === 'system' &&
        ui.accentValue === '#F5A65B' &&
        ui.accentVar === '#F5A65B' &&
        ui.sunriseHidden === true &&
        (ui.theme === 'light' || ui.theme === 'dark'),
      JSON.stringify({
        themeMode: ui.themeMode,
        accent: ui.accentValue,
        accentVar: ui.accentVar,
        sunriseHidden: ui.sunriseHidden,
        theme: ui.theme,
      }),
    );
    check(
      '更新源默认 BALLBALLUUUUU/WORK-OR-RUN',
      ui.updateRepo === 'BALLBALLUUUUU/WORK-OR-RUN',
      ui.updateRepo,
    );
    check(
      '自检期间没有自动打开设置窗口',
      settingsWindow === null,
      String(settingsWindow),
    );

    // 标签页切换：逐个点击后只显示对应面板
    const tabSwitch = await winA.webContents.executeJavaScript(
      `(async () => {
        const out = [];
        for (const name of ['water', 'rest', 'settings', 'about', 'countdown']) {
          document.getElementById('tab-' + name).click();
          await new Promise((resolve) => setTimeout(resolve, 20));
          out.push({
            name,
            visible: Array.from(document.querySelectorAll('.panel')).filter((el) => !el.hidden).map((el) => el.dataset.panel).join(','),
            selected: document.querySelector('.tab[aria-selected="true"]').dataset.tab,
          });
        }
        return out;
      })()`,
    );
    check(
      '标签页点击切换面板（每次只显示一个）',
      tabSwitch.length === 5 &&
        tabSwitch.every((item) => item.visible === item.name && item.selected === item.name),
      JSON.stringify(tabSwitch),
    );

    const switched = await winA.webContents.executeJavaScript(
      `(async () => {
        const select = document.getElementById('restMode');
        select.value = 'alternating';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 60));
        const alt = {
          hidden: document.getElementById('alternatingRow').hidden,
          checked: document.getElementById('alternatingDouble').checked,
        };
        select.value = 'custom';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 60));
        return {
          altHidden: alt.hidden,
          altChecked: alt.checked,
          customHidden: document.getElementById('customRow').hidden,
          checkedDays: Array.from(document.querySelectorAll('input[name="customRestDay"]:checked')).map((el) => Number(el.value)).sort((a, b) => a - b),
        };
      })()`,
    );
    check(
      '切换到大小休时显示「本周为双休周」并从锚点推导',
      switched.altHidden === false && switched.altChecked === true,
      JSON.stringify(switched),
    );
    check(
      '切换到自定义时显示 7 个复选框并回显已存休息日',
      switched.customHidden === false && switched.checkedDays.join(',') === '0,6',
      JSON.stringify(switched),
    );

    // 月排班 UI：标题 / 周行 / 本周标记 / 双休单休切换 / 月份导航 / 不落盘
    const fileBeforePlan = fs.readFileSync(SETTINGS_FILE, 'utf8');
    const monthlyUi = await winA.webContents.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const select = document.getElementById('restMode');
        select.value = 'monthly';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(80);
        const rows = () => Array.from(document.querySelectorAll('#planWeeks .plan-row'));
        const snapshot = () => rows().map((row) => ({
          label: row.querySelector('.plan-label').textContent,
          current: row.querySelector('.plan-current').textContent,
          checked: row.querySelector('input[type="checkbox"]').checked,
          monday: row.querySelector('input[type="checkbox"]').dataset.monday,
        }));
        const currentTitle = document.getElementById('planTitle').textContent;
        const initial = snapshot();
        const legend = document.getElementById('planLegend').textContent;
        const currentRow = rows().find((row) => row.classList.contains('current'));
        let toggledChecked = null;
        if (currentRow) {
          const box = currentRow.querySelector('input[type="checkbox"]');
          box.checked = false;
          box.dispatchEvent(new Event('change', { bubbles: true }));
          await sleep(20);
          toggledChecked = box.checked;
        }
        document.getElementById('planNext').click();
        await sleep(30);
        const nextTitle = document.getElementById('planTitle').textContent;
        document.getElementById('planPrev').click();
        document.getElementById('planPrev').click();
        await sleep(30);
        const prevTitle = document.getElementById('planTitle').textContent;
        document.getElementById('planToday').click();
        await sleep(30);
        const backTitle = document.getElementById('planTitle').textContent;
        return {
          currentTitle,
          initial,
          legend,
          toggledChecked,
          nextTitle,
          prevTitle,
          backTitle,
          currentMonday: currentRow ? currentRow.querySelector('input[type="checkbox"]').dataset.monday : null,
          monthlyHidden: document.getElementById('monthlyRow').hidden,
        };
      })()`,
    );
    const fileAfterPlan = fs.readFileSync(SETTINGS_FILE, 'utf8');
    const todayForPlan = new Date();
    const planTitleNow = `${todayForPlan.getFullYear()}年${todayForPlan.getMonth() + 1}月`;
    const nextMonthDate = new Date(
      todayForPlan.getFullYear(),
      todayForPlan.getMonth() + 1,
      1,
    );
    const prevMonthDate = new Date(
      todayForPlan.getFullYear(),
      todayForPlan.getMonth() - 1,
      1,
    );
    const planTitleNext = `${nextMonthDate.getFullYear()}年${nextMonthDate.getMonth() + 1}月`;
    const planTitlePrev = `${prevMonthDate.getFullYear()}年${prevMonthDate.getMonth() + 1}月`;
    check(
      '按月四周显示月排班（标题/4–6 行/本周标记/图例）',
      monthlyUi.monthlyHidden === false &&
        monthlyUi.currentTitle === planTitleNow &&
        monthlyUi.initial.length >= 4 &&
        monthlyUi.initial.length <= 6 &&
        monthlyUi.initial[0].label.startsWith('第1周 · ') &&
        monthlyUi.initial.every((row) =>
          /^第\d+周 · \d{2}\/\d{2}–\d{2}\/\d{2}$/.test(row.label),
        ) &&
        monthlyUi.initial.filter((row) => row.current === '本周').length === 1 &&
        monthlyUi.legend.includes(
          '双休＝周六、周日休息；单休＝仅周日休息；未配置的周按双休处理。',
        ),
      JSON.stringify(monthlyUi),
    );
    check(
      '月排班月份导航（下月/上月/回到本月）',
      monthlyUi.nextTitle === planTitleNext &&
        monthlyUi.prevTitle === planTitlePrev &&
        monthlyUi.backTitle === planTitleNow,
      `${monthlyUi.nextTitle} / ${monthlyUi.prevTitle} / ${monthlyUi.backTitle}`,
    );
    check(
      '月排班行切换只改内存，不落盘',
      monthlyUi.toggledChecked === false &&
        Boolean(monthlyUi.currentMonday) &&
        fileAfterPlan === fileBeforePlan,
      `${monthlyUi.currentMonday} / file-unchanged=${fileAfterPlan === fileBeforePlan}`,
    );

    const badLunch = await winA.webContents.executeJavaScript(
      `(async () => {
        document.getElementById('restMode').value = 'double';
        document.getElementById('restMode').dispatchEvent(new Event('change', { bubbles: true }));
        document.getElementById('workStart').value = '09:00';
        document.getElementById('workEnd').value = '18:00';
        document.getElementById('lunchEnabled').checked = true;
        document.getElementById('lunchEnabled').dispatchEvent(new Event('change', { bubbles: true }));
        document.getElementById('lunchStart').value = '13:00';
        document.getElementById('lunchEnd').value = '12:00';
        document.getElementById('notifyBeforeMinutes').value = '0';
        document.getElementById('form').requestSubmit();
        await new Promise((resolve) => setTimeout(resolve, 300));
        return {
          message: document.getElementById('message').textContent,
          className: document.getElementById('message').className,
        };
      })()`,
    );
    check(
      '非法午休在界面上被拒绝',
      /午休/.test(badLunch.message) && /error/.test(badLunch.className),
      JSON.stringify(badLunch),
    );
    const afterBadLunch = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    check(
      '非法午休没有写入文件',
      afterBadLunch.lunch.start === '12:00' && afterBadLunch.lunch.end === '13:00',
      JSON.stringify(afterBadLunch.lunch),
    );

    const badNotify = await winA.webContents.executeJavaScript(
      `(async () => {
        document.getElementById('lunchStart').value = '12:00';
        document.getElementById('lunchEnd').value = '13:00';
        document.getElementById('notifyBeforeMinutes').value = '121';
        document.getElementById('form').requestSubmit();
        await new Promise((resolve) => setTimeout(resolve, 300));
        return {
          message: document.getElementById('message').textContent,
          className: document.getElementById('message').className,
        };
      })()`,
    );
    check(
      '非法提前提醒分钟数在界面上被拒绝',
      /0–120|0-120/.test(badNotify.message) && /error/.test(badNotify.className),
      JSON.stringify(badNotify),
    );
    const afterBadNotify = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    check(
      '非法提醒数字没有写入文件',
      afterBadNotify.notifyBeforeMinutes === 0,
      String(afterBadNotify.notifyBeforeMinutes),
    );

    // --- 3. 合法保存：全部新字段 + 托盘刷新 ---
    await winA.webContents.executeJavaScript(
      `(() => {
        document.getElementById('workStart').value = '08:45';
        document.getElementById('workEnd').value = '17:30';
        document.getElementById('restMode').value = 'custom';
        document.getElementById('restMode').dispatchEvent(new Event('change', { bubbles: true }));
        for (const input of document.querySelectorAll('input[name="customRestDay"]')) {
          input.checked = [1, 3].includes(Number(input.value));
        }
        document.getElementById('lunchEnabled').checked = true;
        document.getElementById('lunchStart').value = '12:30';
        document.getElementById('lunchEnd').value = '13:30';
        document.getElementById('overtimeEnabled').checked = true;
        document.getElementById('overtimeEnabled').dispatchEvent(new Event('change', { bubbles: true }));
        document.getElementById('overtimeStart').value = '20:15';
        document.getElementById('notifyAtEnd').checked = false;
        document.getElementById('notifyBeforeMinutes').value = '15';
        document.getElementById('form').requestSubmit();
        return 'submitted';
      })()`,
    );
    const closeDeadline = Date.now() + 5000;
    while (!winA.isDestroyed() && Date.now() < closeDeadline) {
      await delay(100);
    }
    check('保存成功后设置窗口自动关闭', winA.isDestroyed());

    const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    const currentMondayKey = mondayKey(new Date());
    check(
      '合法保存写入新字段（含 weeklyPlan / overtime）',
      saved.workStart === '08:45' &&
        saved.workEnd === '17:30' &&
        saved.restMode === 'custom' &&
        Array.isArray(saved.customRestDays) &&
        saved.customRestDays.join(',') === '1,3' &&
        saved.lunch.start === '12:30' &&
        saved.lunch.end === '13:30' &&
        saved.weeklyPlan[currentMondayKey] === 'single' &&
        saved.overtime.enabled === true &&
        saved.overtime.start === '20:15' &&
        saved.notifyAtEnd === false &&
        saved.notifyBeforeMinutes === 15,
      JSON.stringify(saved),
    );
    check(
      '月排班当前周键为周一起点',
      monthlyUi.currentMonday === currentMondayKey,
      `${monthlyUi.currentMonday} / ${currentMondayKey}`,
    );
    check('旧字段 notify 不再写入', !('notify' in saved), JSON.stringify(saved));
    check(
      '托盘标题立即按新状态刷新',
      tray.getTitle().trim() === currentStatus().title,
      `tray=${tray.getTitle().trim()} status=${currentStatus().title}`,
    );

    // --- 4. 窗口 B：IPC 读回 / 非法 IPC 拒绝 / 新状态托盘 ---
    const winB = makeWindow();
    await winB.loadFile(path.join(__dirname, 'settings.html'));
    await delay(400);
    const roundtrip = await winB.webContents.executeJavaScript('window.offwork.load()');
    check(
      'IPC 读回全部新字段',
      roundtrip.settings.workStart === '08:45' &&
        roundtrip.settings.restMode === 'custom' &&
        roundtrip.settings.customRestDays.join(',') === '1,3' &&
        roundtrip.settings.lunch.start === '12:30' &&
        roundtrip.settings.weeklyPlan[currentMondayKey] === 'single' &&
        roundtrip.settings.overtime.enabled === true &&
        roundtrip.settings.overtime.start === '20:15' &&
        roundtrip.settings.notifyAtEnd === false &&
        roundtrip.settings.notifyBeforeMinutes === 15 &&
        roundtrip.settings.water.goalMl === 2000 &&
        roundtrip.settings.rest.durationMinutes === 5 &&
        roundtrip.settings.appearance.accent === '#F5A65B' &&
        roundtrip.settings.updateRepo === 'BALLBALLUUUUU/WORK-OR-RUN' &&
        roundtrip.meta.version === '1.4.0' &&
        (roundtrip.meta.theme === 'light' || roundtrip.meta.theme === 'dark') &&
        typeof roundtrip.meta.systemPrefersDark === 'boolean' &&
        roundtrip.meta.currentWeekMonday === mondayKey(new Date()),
      JSON.stringify(roundtrip.settings),
    );
    const domB = await winB.webContents.executeJavaScript(
      `({
        workStart: document.getElementById('workStart').value,
        restMode: document.getElementById('restMode').value,
        lunchStart: document.getElementById('lunchStart').value,
        overtimeEnabled: document.getElementById('overtimeEnabled').checked,
        overtimeStart: document.getElementById('overtimeStart').value,
        notifyBefore: document.getElementById('notifyBeforeMinutes').value,
        checkedDays: Array.from(document.querySelectorAll('input[name="customRestDay"]:checked')).map((el) => Number(el.value)).sort((a, b) => a - b),
      })`,
    );
    check(
      '重新打开设置窗口渲染新值',
      domB.workStart === '08:45' &&
        domB.restMode === 'custom' &&
        domB.lunchStart === '12:30' &&
        domB.overtimeEnabled === true &&
        domB.overtimeStart === '20:15' &&
        domB.notifyBefore === '15' &&
        domB.checkedDays.join(',') === '1,3',
      JSON.stringify(domB),
    );

    const ipcBase = settingsDefaultsForSelfTest(new Date());
    const rejectLunch = await winB.webContents.executeJavaScript(
      `window.offwork.save(${JSON.stringify({
        ...ipcBase,
        lunch: { enabled: true, start: '13:00', end: '12:00' },
      })})`,
    );
    check(
      'IPC 拒绝非法午休',
      rejectLunch.ok === false && /午休/.test(rejectLunch.error || ''),
      JSON.stringify(rejectLunch),
    );
    const rejectBefore = await winB.webContents.executeJavaScript(
      `window.offwork.save(${JSON.stringify({
        ...ipcBase,
        notifyBeforeMinutes: 999,
      })})`,
    );
    check(
      'IPC 拒绝非法提前提醒分钟数',
      rejectBefore.ok === false && /0–120/.test(rejectBefore.error || ''),
      JSON.stringify(rejectBefore),
    );
    const rejectOvertime = await winB.webContents.executeJavaScript(
      `window.offwork.save(${JSON.stringify({
        ...ipcBase,
        overtime: { enabled: true, start: '25:00' },
      })})`,
    );
    check(
      'IPC 拒绝非法加班起算时间',
      rejectOvertime.ok === false && /加班/.test(rejectOvertime.error || ''),
      JSON.stringify(rejectOvertime),
    );
    const rejectPlan = await winB.webContents.executeJavaScript(
      `window.offwork.save(${JSON.stringify({
        ...ipcBase,
        restMode: 'monthly',
        weeklyPlan: { '2026-02-31': 'double' },
      })})`,
    );
    check(
      'IPC 拒绝非法周排班',
      rejectPlan.ok === false && /周排班/.test(rejectPlan.error || ''),
      JSON.stringify(rejectPlan),
    );

    const today = new Date().getDay();
    const restSave = await winB.webContents.executeJavaScript(
      `window.offwork.save(${JSON.stringify({
        ...ipcBase,
        restMode: 'custom',
        customRestDays: [today],
        lunch: { enabled: false, start: '12:00', end: '13:00' },
      })})`,
    );
    const restStatus = currentStatus();
    check(
      '保存自定义休息日后进入休息状态',
      restSave.ok === true &&
        restStatus.state === 'rest' &&
        /周末愉快|今天休息/.test(restStatus.title),
      `${restStatus.state} / ${restStatus.title}`,
    );
    check(
      '休息状态托盘标题/菜单同步刷新',
      tray.getTitle().trim() === restStatus.title &&
        buildMenu().items.some((item) => item.label === restStatus.restDescription),
      `tray=${tray.getTitle().trim()} rest=${restStatus.restDescription}`,
    );

    // 午休状态：把午休窗口临时设置为包含当前时刻（接近午夜时跳过构造）
    const now = new Date();
    const lunchStartMinute = now.getHours() * 60 + now.getMinutes() - 1;
    const lunchEndMinute = lunchStartMinute + 3;
    const hhmm = (minutes) =>
      `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(
        minutes % 60,
      ).padStart(2, '0')}`;
    if (lunchStartMinute >= 0 && lunchEndMinute <= 23 * 60 + 59) {
      const lunchStart = hhmm(lunchStartMinute);
      const lunchEnd = hhmm(lunchEndMinute);
      const lunchSave = await winB.webContents.executeJavaScript(
        `window.offwork.save(${JSON.stringify({
          ...ipcBase,
          workStart: '00:00',
          workEnd: '23:59',
          restMode: 'custom',
          customRestDays: [],
          lunch: { enabled: true, start: lunchStart, end: lunchEnd },
        })})`,
      );
      const lunchStatus = currentStatus();
      const lunchMenuLabels = buildMenu().items.map((item) => item.label);
      check(
        '午休中托盘标题刷新为「午休中 HH:MM:SS」',
        lunchSave.ok === true &&
          lunchStatus.state === 'lunch' &&
          /^午休中 \d{2}:\d{2}:\d{2}$/.test(lunchStatus.title) &&
          tray.getTitle().trim() === lunchStatus.title,
        `${lunchStatus.state} / ${lunchStatus.title} / tray=${tray.getTitle().trim()}`,
      );
      check(
        '午休菜单头部与时间段正确',
        lunchMenuLabels[0] === lunchStatus.header &&
          lunchMenuLabels.includes(`午休 ${lunchStart}–${lunchEnd}`),
        JSON.stringify(lunchMenuLabels),
      );
    } else {
      check(
        '午休状态纯逻辑（当前时刻无法构造午休窗口，改用固定时间验证）',
        (() => {
          const probe = computeStatus(
            {
              ...ipcBase,
              lunch: { enabled: true, start: '12:00', end: '13:00' },
            },
            new Date(2026, 10, 9, 12, 30, 0),
          );
          return probe.state === 'lunch' && probe.title === '午休中 00:30:00';
        })(),
      );
    }

    // --- 5. 月排班 IPC 往返 / 周快捷切换 / 加班托盘 ---
    const nextWeekDate = new Date();
    nextWeekDate.setDate(nextWeekDate.getDate() + 7);
    const nextMondayKey = mondayKey(nextWeekDate);
    const monthlySave = await winB.webContents.executeJavaScript(
      `window.offwork.save(${JSON.stringify({
        ...ipcBase,
        restMode: 'monthly',
        weeklyPlan: {
          [currentMondayKey]: 'single',
          [nextMondayKey]: 'double',
        },
        overtime: { enabled: true, start: '18:00' },
      })})`,
    );
    const monthlyFile = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    const monthlyLoad = await winB.webContents.executeJavaScript('window.offwork.load()');
    check(
      '月排班 IPC 往返 + weeklyPlan 持久化',
      monthlySave.ok === true &&
        monthlyFile.restMode === 'monthly' &&
        monthlyFile.weeklyPlan[currentMondayKey] === 'single' &&
        monthlyFile.weeklyPlan[nextMondayKey] === 'double' &&
        monthlyLoad.settings.weeklyPlan[currentMondayKey] === 'single' &&
        monthlyLoad.settings.weeklyPlan[nextMondayKey] === 'double' &&
        monthlyLoad.meta.currentWeekPlan === 'single',
      JSON.stringify(monthlyFile.weeklyPlan),
    );
    const planMenuItem = buildMenu().items.find(
      (item) => item.label === '本周休息安排',
    );
    check(
      'monthly 模式主菜单含「本周休息安排」单选子菜单',
      Boolean(planMenuItem) &&
        Boolean(planMenuItem.submenu) &&
        planMenuItem.submenu.items.map((item) => item.label).join(',') ===
          '双休,单休' &&
        planMenuItem.submenu.items[0].type === 'radio' &&
        planMenuItem.submenu.items[1].type === 'radio' &&
        planMenuItem.submenu.items[0].checked === false &&
        planMenuItem.submenu.items[1].checked === true,
      planMenuItem
        ? planMenuItem.submenu.items
            .map((item) => `${item.label}:${item.type}:${item.checked}`)
            .join(',')
        : '(missing)',
    );

    const toggledPlan = setWeekPlan('double');
    const fileAfterToggle = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    const planAfterToggle = buildMenu().items.find(
      (item) => item.label === '本周休息安排',
    );
    check(
      '周快捷切换立即写入并刷新主菜单/托盘',
      toggledPlan === 'double' &&
        fileAfterToggle.weeklyPlan[currentMondayKey] === 'double' &&
        Boolean(planAfterToggle) &&
        planAfterToggle.submenu.items[0].checked === true &&
        planAfterToggle.submenu.items[1].checked === false &&
        tray.getTitle().trim() === currentStatus().title,
      `plan=${toggledPlan} file=${JSON.stringify(fileAfterToggle.weeklyPlan)}`,
    );
    setWeekPlan('single');

    const todayDow = new Date().getDay();
    const idleOvertimeSave = await winB.webContents.executeJavaScript(
      `window.offwork.save(${JSON.stringify({
        ...ipcBase,
        restMode: 'custom',
        customRestDays: [todayDow],
        lunch: { enabled: false, start: '12:00', end: '13:00' },
        overtime: { enabled: true, start: '00:00' },
      })})`,
    );
    const idleOvertime = computeOvertime(settings, new Date());
    const idleOvertimeAccent = overtimeAccent;
    const idleOvertimeTitle = overtimeTray
      ? overtimeTray.getTitle().trim()
      : null;
    const idleOvertimeMenu = buildOvertimeMenu().items.map((item) => item.label);
    check(
      '加班托盘休息日显示「暂无加班」',
      idleOvertimeSave.ok === true &&
        idleOvertime.state === 'idle' &&
        idleOvertimeTitle === '暂无加班' &&
        idleOvertimeMenu.includes('暂无加班') &&
        idleOvertimeMenu.includes('工作日 00:00 起算'),
      `tray=${idleOvertimeTitle} menu=${JSON.stringify(idleOvertimeMenu)}`,
    );

    const countingOvertimeSave = await winB.webContents.executeJavaScript(
      `window.offwork.save(${JSON.stringify({
        ...ipcBase,
        restMode: 'custom',
        customRestDays: [],
        lunch: { enabled: false, start: '12:00', end: '13:00' },
        overtime: { enabled: true, start: '00:00' },
      })})`,
    );
    const countingOvertimeAccent = overtimeAccent;
    const countingOvertimeTitle = overtimeTray
      ? overtimeTray.getTitle().trim()
      : null;
    const countingOvertimeMenu = buildOvertimeMenu().items;
    const countingMainLabels = buildMenu().items.map((item) => item.label);
    check(
      '加班托盘图标随计时状态切换（idle→counting）',
      idleOvertimeAccent === 'idle' &&
        countingOvertimeAccent === 'counting' &&
        overtimeAccent === 'counting',
      `idle=${idleOvertimeAccent} counting=${countingOvertimeAccent} now=${overtimeAccent}`,
    );
    check(
      '加班托盘计时状态显示精确标题「加班时长:HH:MM:SS」',
      countingOvertimeSave.ok === true &&
        Boolean(overtimeTray) &&
        /^加班时长:\d{2}:\d{2}:\d{2}$/.test(countingOvertimeTitle || ''),
      String(countingOvertimeTitle),
    );
    check(
      '加班托盘菜单结构（禁用标题/起算/设置/退出）',
      /^加班时长:\d{2}:\d{2}:\d{2}$/.test(countingOvertimeMenu[0].label || '') &&
        countingOvertimeMenu[0].enabled === false &&
        countingOvertimeMenu[1].label === '工作日 00:00 起算' &&
        countingOvertimeMenu[1].enabled === false &&
        countingOvertimeMenu.some((item) => item.label === '设置…') &&
        countingOvertimeMenu.some((item) => item.label === '退出'),
      JSON.stringify(countingOvertimeMenu.map((item) => item.label)),
    );
    check(
      '主菜单包含加班详情行',
      countingMainLabels.some((label) =>
        /^加班时长 \d{2}:\d{2}:\d{2}（00:00 起算）$/.test(label),
      ),
      JSON.stringify(countingMainLabels),
    );
    check(
      '两个菜单栏托盘同时存在（倒计时 + 加班）',
      Boolean(tray) && Boolean(overtimeTray),
      `tray=${Boolean(tray)} overtimeTray=${Boolean(overtimeTray)}`,
    );

    const disabledOvertimeSave = await winB.webContents.executeJavaScript(
      `window.offwork.save(${JSON.stringify({
        ...ipcBase,
        restMode: 'custom',
        customRestDays: [],
        overtime: { enabled: false, start: '00:00' },
      })})`,
    );
    check(
      '关闭加班计时后第二托盘被移除',
      disabledOvertimeSave.ok === true &&
        overtimeTray === null &&
        overtimeAccent === null &&
        computeOvertime(settings, new Date()).title === '暂无加班',
      `overtimeTray=${overtimeTray} accent=${overtimeAccent}`,
    );
    const reenabledOvertimeSave = await winB.webContents.executeJavaScript(
      `window.offwork.save(${JSON.stringify({
        ...ipcBase,
        restMode: 'custom',
        customRestDays: [],
        overtime: { enabled: true, start: '00:00' },
      })})`,
    );
    check(
      '重新开启加班后第二托盘恢复',
      reenabledOvertimeSave.ok === true &&
        Boolean(tray) &&
        Boolean(overtimeTray) &&
        overtimeAccent === 'counting' &&
        /^加班时长:\d{2}:\d{2}:\d{2}$/.test(overtimeTray.getTitle().trim()),
      overtimeTray ? `${overtimeTray.getTitle().trim()} accent=${overtimeAccent}` : '(missing)',
    );

    // --- 5.5 v1.4.0：喝水 / 休息 / 外观 / 主题 / 更新检查 / 自动打开 ---
    const waterInitial = await winB.webContents.executeJavaScript(
      'window.offwork.getWater()',
    );
    const waterFirst = await winB.webContents.executeJavaScript(
      'window.offwork.recordWater(250)',
    );
    const waterSecond = await winB.webContents.executeJavaScript(
      'window.offwork.recordWater(150)',
    );
    const waterGet = await winB.webContents.executeJavaScript(
      'window.offwork.getWater()',
    );
    const waterFileNow = JSON.parse(fs.readFileSync(WATER_STATE_FILE, 'utf8'));
    check(
      '喝水 IPC：记录 +250/+150，总量、时间与 water-state.json 正确',
      waterInitial.ok === true &&
        waterInitial.state.totalMl === 0 &&
        waterFirst.ok === true &&
        waterSecond.ok === true &&
        waterGet.ok === true &&
        waterGet.state.totalMl === 400 &&
        waterGet.state.records.length === 2 &&
        /^\d{2}:\d{2}$/.test(waterGet.state.records[0].at) &&
        waterGet.state.records[0].ml === 250 &&
        waterGet.state.records[1].ml === 150 &&
        waterFileNow.day === dayKey(new Date()) &&
        waterFileNow.totalMl === 400 &&
        Array.isArray(waterFileNow.records) &&
        waterFileNow.records.length === 2,
      `initial=${JSON.stringify(waterInitial.state)} now=${JSON.stringify(waterGet.state)} file=${JSON.stringify(waterFileNow)}`,
    );
    check(
      '喝水 IPC：进度百分比即时（400/2000 = 20%）',
      waterGet.state.goalMl === 2000 &&
        waterGet.state.percent === 20 &&
        waterGet.state.cupMl === 250,
      `${waterGet.state.percent}% goal=${waterGet.state.goalMl} cup=${waterGet.state.cupMl}`,
    );
    const waterRejects = await winB.webContents.executeJavaScript(`(async () => {
      const zero = await window.offwork.recordWater(0);
      const big = await window.offwork.recordWater(2001);
      const frac = await window.offwork.recordWater(1.5);
      return { zero, big, frac };
    })()`);
    check(
      '喝水 IPC 拒绝非法金额（0 / 2001 / 小数）',
      waterRejects.zero.ok === false &&
        waterRejects.big.ok === false &&
        waterRejects.frac.ok === false &&
        /1–2000/.test(waterRejects.zero.error || ''),
      JSON.stringify(waterRejects),
    );

    // 界面上点 +150 -> 进度条/百分比立即更新；再清空
    const waterUi = await winB.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      await window.offwork.clearWater();
      document.getElementById('waterGoal').value = '2000';
      document.getElementById('tab-water').click();
      await sleep(30);
      document.querySelector('[data-water-ml="150"]').click();
      await sleep(250);
      const afterAdd = {
        total: document.getElementById('waterTotal').textContent,
        goal: document.getElementById('waterGoalText').textContent,
        percent: document.getElementById('waterPercent').textContent,
        bar: document.getElementById('waterProgressBar').style.width,
        rows: document.querySelectorAll('#waterList .water-row').length,
        aria: document.getElementById('waterProgress').getAttribute('aria-valuenow'),
        emptyHidden: document.getElementById('waterEmpty').hidden,
      };
      document.getElementById('waterClear').click();
      await sleep(250);
      const afterClear = {
        total: document.getElementById('waterTotal').textContent,
        percent: document.getElementById('waterPercent').textContent,
        rows: document.querySelectorAll('#waterList .water-row').length,
        emptyHidden: document.getElementById('waterEmpty').hidden,
        clearDisabled: document.getElementById('waterClear').disabled,
      };
      return { afterAdd, afterClear };
    })()`);
    check(
      '喝水标签页按钮即时更新进度（+150 → 8%）并可清空',
      waterUi.afterAdd.total === '150' &&
        waterUi.afterAdd.goal === '2000' &&
        waterUi.afterAdd.percent === '8%' &&
        waterUi.afterAdd.bar === '8%' &&
        waterUi.afterAdd.rows === 1 &&
        waterUi.afterAdd.aria === '8' &&
        waterUi.afterAdd.emptyHidden === true &&
        waterUi.afterClear.total === '0' &&
        waterUi.afterClear.percent === '0%' &&
        waterUi.afterClear.rows === 0 &&
        waterUi.afterClear.emptyHidden === false &&
        waterUi.afterClear.clearDisabled === true,
      JSON.stringify(waterUi),
    );

    // 损坏的 water-state.json 不会崩溃：安全重置为空
    fs.writeFileSync(WATER_STATE_FILE, '{ this is not valid json', 'utf8');
    waterState = null;
    const recoveredWater = loadWaterState(new Date());
    check(
      'water-state.json 损坏时安全重置（不崩溃）',
      recoveredWater.totalMl === 0 &&
        recoveredWater.records.length === 0 &&
        recoveredWater.day === dayKey(new Date()),
      JSON.stringify(recoveredWater),
    );

    // 新字段校验：非法值一律拒绝且不落盘
    const waterRejectSaves = await winB.webContents.executeJavaScript(`(async () => {
      const base = ${JSON.stringify(settingsDefaultsForSelfTest(new Date()))};
      const out = [];
      out.push(await window.offwork.save({...base, water: {...base.water, intervalMinutes: 0}}));
      out.push(await window.offwork.save({...base, water: {...base.water, intervalMinutes: 601}}));
      out.push(await window.offwork.save({...base, water: {...base.water, goalMl: 99}}));
      out.push(await window.offwork.save({...base, water: {...base.water, goalMl: 10001}}));
      out.push(await window.offwork.save({...base, water: {...base.water, cupMl: 49}}));
      out.push(await window.offwork.save({...base, water: {...base.water, cupMl: 2001}}));
      return out;
    })()`);
    check(
      'IPC 拒绝非法喝水间隔/目标/每次量（0/601/99/10001/49/2001）',
      waterRejectSaves.length === 6 &&
        waterRejectSaves.every((item) => item.ok === false) &&
        waterRejectSaves.every((item) => /喝水|提醒|目标|喝水量/.test(item.error || '')),
      JSON.stringify(waterRejectSaves.map((item) => item.error)),
    );
    const restRejectSaves = await winB.webContents.executeJavaScript(`(async () => {
      const base = ${JSON.stringify(settingsDefaultsForSelfTest(new Date()))};
      const out = [];
      out.push(await window.offwork.save({...base, rest: {...base.rest, intervalMinutes: 0}}));
      out.push(await window.offwork.save({...base, rest: {...base.rest, intervalMinutes: 601}}));
      out.push(await window.offwork.save({...base, rest: {...base.rest, durationMinutes: 0}}));
      out.push(await window.offwork.save({...base, rest: {...base.rest, durationMinutes: 121}}));
      return out;
    })()`);
    check(
      'IPC 拒绝非法休息间隔/时长（0/601/0/121）',
      restRejectSaves.length === 4 &&
        restRejectSaves.every((item) => item.ok === false) &&
        restRejectSaves.every((item) => /休息|提醒/.test(item.error || '')),
      JSON.stringify(restRejectSaves.map((item) => item.error)),
    );
    const lookRejectSaves = await winB.webContents.executeJavaScript(`(async () => {
      const base = ${JSON.stringify(settingsDefaultsForSelfTest(new Date()))};
      const out = [];
      out.push(await window.offwork.save({...base, appearance: {...base.appearance, themeMode: 'auto'}}));
      out.push(await window.offwork.save({...base, appearance: {...base.appearance, accent: 'red'}}));
      out.push(await window.offwork.save({...base, appearance: {...base.appearance, accent: '#12345'}}));
      out.push(await window.offwork.save({...base, appearance: {...base.appearance, sunrise: '18:00', sunset: '06:00'}}));
      out.push(await window.offwork.save({...base, updateRepo: 'not-a-repo'}));
      return out;
    })()`);
    check(
      'IPC 拒绝非法主题/高亮色/日出日落/更新源',
      lookRejectSaves.length === 5 &&
        lookRejectSaves.every((item) => item.ok === false) &&
        lookRejectSaves.every((item) => /主题|颜色|日出|日落|更新源/.test(item.error || '')),
      JSON.stringify(lookRejectSaves.map((item) => item.error)),
    );
    const fileAfterRejects = fs.readFileSync(SETTINGS_FILE, 'utf8');

    // 界面本地校验：喝水间隔 0 时不会落盘
    const localRejectWater = await winB.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      document.getElementById('waterInterval').value = '0';
      document.getElementById('form').requestSubmit();
      await sleep(200);
      return {
        message: document.getElementById('message').textContent,
        className: document.getElementById('message').className,
      };
    })()`);
    const fileAfterLocalReject = fs.readFileSync(SETTINGS_FILE, 'utf8');
    check(
      '界面本地校验拒绝喝水间隔 0 且不落盘',
      /喝水提醒间隔/.test(localRejectWater.message) &&
        /error/.test(localRejectWater.className) &&
        fileAfterLocalReject === fileAfterRejects,
      JSON.stringify(localRejectWater),
    );

    // 合法的新字段：保存并持久化
    const acceptNew = await winB.webContents.executeJavaScript(
      `window.offwork.save(${JSON.stringify({
        ...ipcBase,
        water: {
          enabled: true,
          intervalMinutes: 30,
          goalMl: 2500,
          cupMl: 300,
          workHoursOnly: false,
        },
        rest: {
          enabled: false,
          intervalMinutes: 60,
          durationMinutes: 10,
          workHoursOnly: true,
        },
        appearance: {
          themeMode: 'dark',
          accent: '#4A90D9',
          sunrise: '07:00',
          sunset: '18:30',
        },
        updateRepo: 'owner/repo',
      })})`,
    );
    const newSaved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    const newLoad = await winB.webContents.executeJavaScript(
      'window.offwork.load()',
    );
    check(
      'IPC 合法保存新字段（喝水/休息/外观/更新源）并持久化',
      acceptNew.ok === true &&
        newSaved.water.intervalMinutes === 30 &&
        newSaved.water.goalMl === 2500 &&
        newSaved.water.cupMl === 300 &&
        newSaved.water.workHoursOnly === false &&
        newSaved.rest.enabled === false &&
        newSaved.rest.durationMinutes === 10 &&
        newSaved.appearance.themeMode === 'dark' &&
        newSaved.appearance.accent === '#4A90D9' &&
        newSaved.appearance.sunrise === '07:00' &&
        newSaved.updateRepo === 'owner/repo' &&
        newLoad.settings.water.cupMl === 300 &&
        newLoad.meta.theme === 'dark',
      JSON.stringify({
        water: newSaved.water,
        rest: newSaved.rest,
        appearance: newSaved.appearance,
        updateRepo: newSaved.updateRepo,
        theme: newLoad.meta.theme,
      }),
    );
    check(
      '保存设置后提醒基线重置（当前时刻 / 今天）',
      Number.isFinite(reminderBaselines.water.atMs) &&
        Date.now() - reminderBaselines.water.atMs < 5000 &&
        reminderBaselines.water.day === dayKey(new Date()) &&
        reminderBaselines.rest.day === dayKey(new Date()),
      JSON.stringify(reminderBaselines),
    );
    check(
      '旧设置字段在保存新字段后仍保留（launchAtLogin / lastSeenVersion）',
      newSaved.launchAtLogin === settings.launchAtLogin &&
        newSaved.lastSeenVersion === settings.lastSeenVersion,
      `launchAtLogin=${newSaved.launchAtLogin} lastSeen=${newSaved.lastSeenVersion}`,
    );

    // 主题解析：light / dark / system / sun
    const previews = await winB.webContents.executeJavaScript(`(async () => {
      const light = await window.offwork.previewTheme({themeMode: 'light'});
      const dark = await window.offwork.previewTheme({themeMode: 'dark'});
      const system = await window.offwork.previewTheme({themeMode: 'system'});
      const sun = await window.offwork.previewTheme({themeMode: 'sun', sunrise: '06:30', sunset: '18:00'});
      return { light, dark, system, sun };
    })()`);
    const expectedSystem = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
    const expectedSun = resolveTheme(
      { themeMode: 'sun', sunrise: '06:30', sunset: '18:00' },
      new Date(),
      nativeTheme.shouldUseDarkColors,
    );
    check(
      '主题解析 IPC：light/dark/system/sun 与主进程一致',
      previews.light.theme === 'light' &&
        previews.dark.theme === 'dark' &&
        previews.system.theme === expectedSystem &&
        previews.sun.theme === expectedSun,
      JSON.stringify(previews),
    );

    // 设置窗口内的实时预览：深色/浅色切换 + 高亮色
    const livePreview = await winB.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const choose = async (mode) => {
        const input = document.querySelector('input[name="themeMode"][value="' + mode + '"]');
        input.checked = true;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(150);
        return document.documentElement.dataset.theme;
      };
      const dark = await choose('dark');
      const light = await choose('light');
      const accent = document.getElementById('accentCustom');
      accent.value = '#8FD19E';
      accent.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(30);
      return {
        dark,
        light,
        accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().toUpperCase(),
        swatchChecked: document.querySelector('.swatch[data-accent="#8FD19E"]').getAttribute('aria-checked'),
        sunriseHidden: document.getElementById('sunriseRow').hidden,
      };
    })()`);
    check(
      '设置窗口实时预览：深色/浅色主题切换 + 高亮色',
      livePreview.dark === 'dark' &&
        livePreview.light === 'light' &&
        livePreview.accent === '#8FD19E' &&
        livePreview.swatchChecked === 'true' &&
        livePreview.sunriseHidden === true,
      JSON.stringify(livePreview),
    );

    // 日出日落模式显示/隐藏时间输入
    const sunRows = await winB.webContents.executeJavaScript(`(async () => {
      const input = document.querySelector('input[name="themeMode"][value="sun"]');
      input.checked = true;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      const shown = {
        sunriseHidden: document.getElementById('sunriseRow').hidden,
        sunsetHidden: document.getElementById('sunsetRow').hidden,
      };
      const back = document.querySelector('input[name="themeMode"][value="system"]');
      back.checked = true;
      back.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      return {
        shown,
        hiddenAgain: document.getElementById('sunriseRow').hidden,
        systemTheme: document.documentElement.dataset.theme,
      };
    })()`);
    check(
      '跟随日出日落时显示日出/日落输入，切回后隐藏',
      sunRows.shown.sunriseHidden === false &&
        sunRows.shown.sunsetHidden === false &&
        sunRows.hiddenAgain === true &&
        sunRows.systemTheme === expectedSystem,
      JSON.stringify(sunRows),
    );

    // 更新检查失败路径（自检环境禁用）+ 非 GitHub URL 拒绝
    const updateFail = await winB.webContents.executeJavaScript(
      'window.offwork.checkUpdate()',
    );
    const openRejected = await winB.webContents.executeJavaScript(
      "window.offwork.openRelease('https://evil.example/release')",
    );
    check(
      '更新检查失败路径：自检环境禁用，返回清晰错误且不崩溃',
      updateFail &&
        updateFail.status === 'error' &&
        updateFail.currentVersion === app.getVersion() &&
        /已禁用/.test(updateFail.message || ''),
      JSON.stringify(updateFail),
    );
    check(
      '打开 Release 页面只允许 GitHub https URL',
      openRejected.ok === false && /GitHub/.test(openRejected.error || ''),
      JSON.stringify(openRejected),
    );

    // 自动打开设置窗口的版本变化逻辑
    check(
      '自动打开设置：首次安装 / 版本变化为 true，同版本与自检为 false',
      shouldAutoOpenSettings({
        hadSettingsFile: false,
        appVersion: app.getVersion(),
      }) === true &&
        shouldAutoOpenSettings({
          hadSettingsFile: true,
          lastSeenVersion: '1.3.0',
          appVersion: app.getVersion(),
        }) === true &&
        shouldAutoOpenSettings({
          hadSettingsFile: true,
          lastSeenVersion: app.getVersion(),
          appVersion: app.getVersion(),
        }) === false &&
        shouldAutoOpenSettings({
          hadSettingsFile: false,
          appVersion: app.getVersion(),
          selftest: true,
        }) === false,
      `appVersion=${app.getVersion()}`,
    );

    // --- 6. 恢复默认设置并校验落盘 ---
    const restored = await winB.webContents.executeJavaScript(
      `window.offwork.save(${JSON.stringify(settingsDefaultsForSelfTest(new Date()))})`,
    );
    const restoredFile = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    check(
      '恢复默认设置成功',
      restored.ok === true &&
        restoredFile.workStart === '09:00' &&
        restoredFile.workEnd === '18:00' &&
        restoredFile.restMode === 'double' &&
        restoredFile.notifyBeforeMinutes === 0 &&
        Object.keys(restoredFile.weeklyPlan).length === 0 &&
        restoredFile.overtime.enabled === true &&
        restoredFile.overtime.start === '18:00',
      JSON.stringify(restoredFile),
    );
    winB.destroy();

    // --- 7. 证明没有写真实设置 ---
    let realAfter = null;
    let realAfterHash = null;
    try {
      realAfter = fs.readFileSync(REAL_SETTINGS_FILE, 'utf8');
      realAfterHash = crypto
        .createHash('sha256')
        .update(realAfter)
        .digest('hex');
    } catch {
      realAfter = null;
      realAfterHash = null;
    }
    check(
      '真实用户 settings.json 内容/哈希均未被自检修改',
      realAfter === realSettingsSnapshot && realAfterHash === realSettingsHash,
      realSettingsSnapshot === null
        ? '(真实设置不存在)'
        : `内容一致=${realAfter === realSettingsSnapshot} sha256=${realAfterHash}`,
    );

    const failed = results.filter((item) => !item.ok);
    log(
      `SELFTEST ${failed.length ? 'FAIL' : 'PASS'} (${results.length - failed.length}/${results.length})`,
    );
    return failed.length === 0;
  } catch (error) {
    log(`SELFTEST ERROR ${error && error.stack ? error.stack : error}`);
    return false;
  }
}

/**
 * 自检收尾：把自检日志复制到 /tmp/offwork-selftest-result.log（方便用 open
 * 启动、看不到 stdout 时检查），然后删除隔离的临时 userData 并退出。
 */
function finishSelfTest(ok) {
  try {
    const summary = fs.readFileSync(LOG_FILE, 'utf8');
    fs.writeFileSync(SELFTEST_SUMMARY_FILE, summary, 'utf8');
    console.log(summary);
  } catch (error) {
    console.error('[offwork] selftest summary failed:', error);
  }
  if (USER_DATA.startsWith('/tmp/offwork-selftest-')) {
    try {
      fs.rmSync(USER_DATA, { recursive: true, force: true });
    } catch (error) {
      console.error('[offwork] selftest cleanup failed:', error);
    }
  }
  app.exit(ok ? 0 : 1);
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  // 第二个实例：交给已运行实例处理，然后立即退出。
  log('another instance is already running, quitting.');
  app.quit();
} else {
  app.on('second-instance', () => {
    log('second-instance：已有实例在运行，打开设置窗口。');
    openSettingsWindow();
  });

  app.whenReady().then(() => {
    if (typeof app.dock?.hide === 'function') app.dock.hide();
    loadSettings();
    loadNotifyState();
    loadWaterState(new Date());
    resetReminderBaselines(new Date(), 'app ready');
    lastPublishedTheme = resolvedTheme();
    nativeTheme.on('updated', () => publishTheme(true));
    buildApplicationMenu();

    const initialAccent = trayAccentState(settings, new Date());
    const initialStyle = trayAccentStyle(initialAccent);
    let icon = cachedTrayImage(initialStyle.file, false);
    let iconFallback = false;
    if (icon.isEmpty()) {
      icon = cachedTrayImage('SunClockTemplate.png', true);
      iconFallback = true;
    }
    tray = new Tray(icon);
    tray.on('click', showMenu);
    tray.on('right-click', showMenu);
    trayAccent = initialAccent;
    log(
      `tray icon state=${initialAccent} color=${initialStyle.color}${iconFallback ? ' fallback=template' : ''}`,
    );

    const status = applyTrayTitle();
    const overtime = applyOvertime(new Date());
    previousStatus = status;
    previousOvertimeState = overtime.state;
    log(`tray created, title=${status.title} rest=${status.restDescription}`);
    log(
      `overtime tray ready, title=${overtime.title} enabled=${overtime.enabled} start=${settings.overtime.start}`,
    );

    tick();
    timer = setInterval(tick, 1000);
    if (typeof timer.unref === 'function') timer.unref();

    log(
      `${APP_NAME} ready · pid=${process.pid} · version=${app.getVersion()} · electron=${process.versions.electron} · tick=1000ms`,
    );

    // 首次安装 / 版本变化：自动打开一次设置窗口，并记录 lastSeenVersion。
    // 自检（SELFTEST）永远不打开窗口，也不写真实设置。
    const previousSeenVersion = settings.lastSeenVersion;
    const autoOpen = shouldAutoOpenSettings({
      hadSettingsFile: HAD_SETTINGS_FILE_AT_STARTUP,
      lastSeenVersion: previousSeenVersion,
      appVersion: app.getVersion(),
      selftest: SELFTEST,
    });
    if (!SELFTEST) {
      if (previousSeenVersion !== app.getVersion()) {
        settings = sanitizeSettings(
          { ...settings, lastSeenVersion: app.getVersion() },
          new Date(),
        );
        try {
          persistSettings(settings);
          log(
            `lastSeenVersion: ${previousSeenVersion || '(none)'} -> ${app.getVersion()}`,
          );
        } catch (error) {
          log(`保存 lastSeenVersion 失败：${error.message}`);
        }
      }
      if (autoOpen) {
        log(
          `auto-open settings: hadSettingsFile=${HAD_SETTINGS_FILE_AT_STARTUP} lastSeenVersion=${previousSeenVersion || '(none)'} appVersion=${app.getVersion()}`,
        );
        openSettingsWindow();
      } else {
        log(
          `auto-open settings skipped: lastSeenVersion=${previousSeenVersion || '(none)'} appVersion=${app.getVersion()}`,
        );
      }
    }

    if (SELFTEST) {
      runSelfTest().then((ok) => {
        setTimeout(() => finishSelfTest(ok), 200);
      });
    }
  });

  // 关掉设置窗口后继续常驻菜单栏。
  app.on('window-all-closed', () => {
    /* 保持运行 */
  });

  app.on('before-quit', () => {
    if (timer) clearInterval(timer);
    timer = null;
  });

  process.on('uncaughtException', (error) => {
    log(`uncaughtException: ${error && error.stack ? error.stack : error}`);
  });
  process.on('unhandledRejection', (reason) => {
    log(`unhandledRejection: ${reason}`);
  });
}
