'use strict';

/**
 * 纯逻辑（不依赖 Electron），便于用 Node 直接做单元测试。
 * 时间全部按本机本地时区计算（Asia/Shanghai）。
 *
 * 这里包含：
 *  - 设置规范化 / 保存前校验（含旧版 notify -> notifyAtEnd 迁移）
 *  - 休息日（双休 / 单休 / 大小休 / 自定义）判定
 *  - 倒计时 / 午休 / 已下班 / 休息 状态计算
 *  - 提前提醒阈值跨越、下班提醒等纯函数
 */

const REST_MODES = Object.freeze([
  'double',
  'single',
  'alternating',
  'monthly',
  'custom',
]);
const REST_MODE_NAMES = Object.freeze({
  double: '双休',
  single: '单休',
  alternating: '大小休',
  monthly: '按月四周',
  custom: '自定义',
});
const WEEK_PLANS = Object.freeze(['double', 'single']);
// 0 = 周日 … 6 = 周六（与 Date#getDay 一致）
const WEEKDAY_NAMES = Object.freeze(['周日', '周一', '周二', '周三', '周四', '周五', '周六']);
const NOTIFY_BEFORE_MAX = 120;

const TIME_RE = /^([0-9]{1,2}):([0-9]{2})$/;
const DATE_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

/** 解析 "H:MM" / "HH:MM"（24 小时制）；非法返回 null。 */
function parseClock(value) {
  if (typeof value !== 'string') return null;
  const match = TIME_RE.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return { hours, minutes, minutesOfDay: hours * 60 + minutes };
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatClock(clock) {
  return `${pad2(clock.hours)}:${pad2(clock.minutes)}`;
}

/** 把任意输入规范化成 "HH:MM"，非法时返回 fallback。 */
function normalizeTime(value, fallback) {
  const parsed = parseClock(value);
  return parsed ? formatClock(parsed) : fallback;
}

/** 本地日期 -> YYYY-MM-DD。 */
function dayKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** 严格的 YYYY-MM-DD 解析；非法/不存在的日期返回 null。 */
function parseDateKey(value) {
  if (typeof value !== 'string') return null;
  const match = DATE_RE.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return {
    year,
    month,
    day,
    // 用 UTC 日期序号做“天”的加减，避开夏令时/时区问题。
    dayNumber: Math.floor(Date.UTC(year, month - 1, day) / 86400000),
  };
}

function keyFromDayNumber(dayNumber) {
  const date = new Date(dayNumber * 86400000);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function dayNumberOf(date) {
  return Math.floor(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000,
  );
}

/** 0 = 周日 … 6 = 周六（由日期序号反推，1970-01-01 是周四）。 */
function weekdayOfDayNumber(dayNumber) {
  return (((dayNumber + 4) % 7) + 7) % 7;
}

/** 以周一为一周起点，返回某天所在周的周一（YYYY-MM-DD）。 */
function mondayKey(date = new Date()) {
  const monday = dayNumberOf(date) - ((date.getDay() + 6) % 7);
  return keyFromDayNumber(monday);
}

/** 大小休：判断 `date` 所在周是否为双休周。 */
function alternatingWeekIsDouble(alternating, date = new Date()) {
  const src = alternating && typeof alternating === 'object' ? alternating : {};
  const anchor = parseDateKey(src.anchorDate);
  const anchorIsDouble =
    typeof src.anchorIsDouble === 'boolean' ? src.anchorIsDouble : true;
  if (!anchor) return anchorIsDouble;
  const anchorMonday =
    anchor.dayNumber - ((weekdayOfDayNumber(anchor.dayNumber) + 6) % 7);
  const currentMonday = dayNumberOf(date) - ((date.getDay() + 6) % 7);
  const weeks = Math.round((currentMonday - anchorMonday) / 7);
  const isDouble = weeks % 2 === 0 ? anchorIsDouble : !anchorIsDouble;
  return isDouble;
}

/** 当前周大小休标签："双休周" / "单休周"。 */
function alternatingWeekLabel(alternating, date = new Date()) {
  return alternatingWeekIsDouble(alternating, date) ? '双休周' : '单休周';
}

/** 规范化月排班：只保留合法的周一双休/单休项，非周一的键归一到所在周一。 */
function sanitizeWeeklyPlan(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [rawKey, plan] of Object.entries(value)) {
    if (!WEEK_PLANS.includes(plan)) continue;
    const parsed = parseDateKey(rawKey);
    if (!parsed) continue;
    const monday =
      parsed.dayNumber - ((weekdayOfDayNumber(parsed.dayNumber) + 6) % 7);
    out[keyFromDayNumber(monday)] = plan;
  }
  const sorted = {};
  for (const key of Object.keys(out).sort()) sorted[key] = out[key];
  return sorted;
}

/**
 * 某一周（周一为起点）的休息安排：'double'（周六+周日）或 'single'（仅周日）。
 * `weeklyPlan` 里没有该周时回退为 'double'。
 */
function resolveWeekPlan(settings, date = new Date()) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const plan = sanitizeWeeklyPlan(s.weeklyPlan);
  const value = plan[mondayKey(date)];
  return value === 'single' ? 'single' : 'double';
}

/**
 * 枚举与指定月份相交的所有「周一制」周（通常 4–6 行，可能包含跨月周）。
 * 返回 [{ index, monday, startKey, endKey, startYear, startMonth, startDay,
 *          endYear, endMonth, endDay, label, isCurrent }]，月份从 0 开始。
 * label 形如 `第1周 · 10/26–11/01`；`isCurrent` 标记 now 所在周。
 */
function weeksOfMonth(year, monthIndex, now = new Date()) {
  const base = new Date(year, monthIndex, 1);
  const y = base.getFullYear();
  const m = base.getMonth();
  const firstDayNumber = dayNumberOf(new Date(y, m, 1));
  const lastDayNumber = dayNumberOf(new Date(y, m + 1, 0));
  const firstMonday =
    firstDayNumber - ((weekdayOfDayNumber(firstDayNumber) + 6) % 7);
  const lastMonday =
    lastDayNumber - ((weekdayOfDayNumber(lastDayNumber) + 6) % 7);
  const currentMonday = mondayKey(now);
  const weeks = [];
  let index = 1;
  for (let monday = firstMonday; monday <= lastMonday; monday += 7) {
    const sunday = monday + 6;
    const start = new Date(monday * 86400000);
    const end = new Date(sunday * 86400000);
    const startYear = start.getUTCFullYear();
    const startMonth = start.getUTCMonth();
    const startDay = start.getUTCDate();
    const endYear = end.getUTCFullYear();
    const endMonth = end.getUTCMonth();
    const endDay = end.getUTCDate();
    const mondayKeyText = keyFromDayNumber(monday);
    weeks.push({
      index,
      monday: mondayKeyText,
      startKey: keyFromDayNumber(monday),
      endKey: keyFromDayNumber(sunday),
      startYear,
      startMonth,
      startDay,
      endYear,
      endMonth,
      endDay,
      label: `第${index}周 · ${pad2(startMonth + 1)}/${pad2(startDay)}–${pad2(
        endMonth + 1,
      )}/${pad2(endDay)}`,
      isCurrent: mondayKeyText === currentMonday,
    });
    index += 1;
  }
  return weeks;
}

/** 「本月：第N周 双休/单休」——当前周在当月周列表中的序号。 */
function monthlyWeekSummary(settings, now = new Date()) {
  const weeks = weeksOfMonth(now.getFullYear(), now.getMonth(), now);
  const current = weeks.find((week) => week.isCurrent);
  const plan = resolveWeekPlan(settings, now);
  const index = current ? current.index : 1;
  return `本月：第${index}周 ${plan === 'double' ? '双休' : '单休'}`;
}

/** 规范化自定义休息日：非法结构回退默认 [0,6]，合法项去重并排序。 */
function normalizeCustomRestDays(value) {
  if (!Array.isArray(value)) return [0, 6];
  if (!value.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)) {
    return [0, 6];
  }
  return [...new Set(value)].sort((a, b) => a - b);
}

function normalizeNotifyBeforeMinutes(value) {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > NOTIFY_BEFORE_MAX
  ) {
    return null;
  }
  return value;
}

/** 午休：默认 12:00–13:00；启用但时间倒序时视为未启用（避免出现荒谬的午休状态）。 */
function sanitizeLunch(value) {
  const src = value && typeof value === 'object' ? value : {};
  const enabled = typeof src.enabled === 'boolean' ? src.enabled : true;
  const start = normalizeTime(src.start, '12:00');
  const end = normalizeTime(src.end, '13:00');
  const startClock = parseClock(start);
  const endClock = parseClock(end);
  if (enabled && endClock.minutesOfDay <= startClock.minutesOfDay) {
    return { enabled: false, start, end };
  }
  return { enabled, start, end };
}

function sanitizeAlternating(value, now = new Date()) {
  const src = value && typeof value === 'object' ? value : {};
  const anchor = parseDateKey(src.anchorDate) ? src.anchorDate : mondayKey(now);
  return {
    anchorDate: anchor,
    anchorIsDouble:
      typeof src.anchorIsDouble === 'boolean' ? src.anchorIsDouble : true,
  };
}

/** 加班：默认开启，起算时间缺失时回退到当前下班时间。 */
function sanitizeOvertime(value, workEnd) {
  const src = value && typeof value === 'object' ? value : {};
  return {
    enabled: typeof src.enabled === 'boolean' ? src.enabled : true,
    start: normalizeTime(src.start, workEnd),
  };
}

// ---------------------------------------------------------------------------
// v1.4.0：喝水提醒 / 休息提醒 / 外观 / 更新检查 / 首次启动自动打开设置
// ---------------------------------------------------------------------------

const WATER_DEFAULTS = Object.freeze({
  enabled: true,
  intervalMinutes: 45,
  goalMl: 2000,
  cupMl: 250,
  workHoursOnly: true,
});
const REST_DEFAULTS = Object.freeze({
  enabled: true,
  intervalMinutes: 45,
  durationMinutes: 5,
  workHoursOnly: true,
});
const APPEARANCE_DEFAULTS = Object.freeze({
  themeMode: 'system',
  accent: '#F5A65B',
  sunrise: '06:30',
  sunset: '18:00',
});
const THEME_MODES = Object.freeze(['system', 'sun', 'light', 'dark']);
const ACCENT_PRESETS = Object.freeze([
  '#F5A65B',
  '#8FD19E',
  '#4A90D9',
  '#8E7CC3',
  '#E48FB3',
  '#E5533D',
]);
const DEFAULT_UPDATE_REPO = 'BALLBALLUUUUU/WORK-OR-RUN';
const WATER_AMOUNT_MIN = 1;
const WATER_AMOUNT_MAX = 2000;
const WATER_RECORD_MAX_ML = 5000;
const WATER_TOTAL_MAX_ML = 100000;

const WATER_LIMITS = Object.freeze({
  interval: [1, 600],
  goal: [100, 10000],
  cup: [50, 2000],
});
const REST_LIMITS = Object.freeze({
  interval: [1, 600],
  duration: [1, 120],
});

/** 数字/数字字符串 -> 整数；其它返回 null。 */
function toInteger(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number.isInteger(value) ? value : null;
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return null;
}

/** 规范化到范围内的整数，非法或越界返回 fallback。 */
function normalizeBoundedInt(value, min, max, fallback) {
  const number = toInteger(value);
  return number !== null && number >= min && number <= max ? number : fallback;
}

/** 规范化十六进制颜色：支持 #RGB / #RRGGBB；非法返回 null。大写输出。 */
function normalizeAccent(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const long = /^#([0-9a-fA-F]{6})$/.exec(text);
  if (long) return `#${long[1].toUpperCase()}`;
  const short = /^#([0-9a-fA-F]{3})$/.exec(text);
  if (short) {
    return `#${[...short[1]]
      .map((char) => `${char}${char}`)
      .join('')
      .toUpperCase()}`;
  }
  return null;
}

function sanitizeWaterSettings(value) {
  const src = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    enabled: typeof src.enabled === 'boolean' ? src.enabled : WATER_DEFAULTS.enabled,
    intervalMinutes: normalizeBoundedInt(
      src.intervalMinutes,
      WATER_LIMITS.interval[0],
      WATER_LIMITS.interval[1],
      WATER_DEFAULTS.intervalMinutes,
    ),
    goalMl: normalizeBoundedInt(
      src.goalMl,
      WATER_LIMITS.goal[0],
      WATER_LIMITS.goal[1],
      WATER_DEFAULTS.goalMl,
    ),
    cupMl: normalizeBoundedInt(
      src.cupMl,
      WATER_LIMITS.cup[0],
      WATER_LIMITS.cup[1],
      WATER_DEFAULTS.cupMl,
    ),
    workHoursOnly:
      typeof src.workHoursOnly === 'boolean'
        ? src.workHoursOnly
        : WATER_DEFAULTS.workHoursOnly,
  };
}

function sanitizeRestSettings(value) {
  const src = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    enabled: typeof src.enabled === 'boolean' ? src.enabled : REST_DEFAULTS.enabled,
    intervalMinutes: normalizeBoundedInt(
      src.intervalMinutes,
      REST_LIMITS.interval[0],
      REST_LIMITS.interval[1],
      REST_DEFAULTS.intervalMinutes,
    ),
    durationMinutes: normalizeBoundedInt(
      src.durationMinutes,
      REST_LIMITS.duration[0],
      REST_LIMITS.duration[1],
      REST_DEFAULTS.durationMinutes,
    ),
    workHoursOnly:
      typeof src.workHoursOnly === 'boolean'
        ? src.workHoursOnly
        : REST_DEFAULTS.workHoursOnly,
  };
}

function sanitizeAppearance(value) {
  const src = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const themeMode = THEME_MODES.includes(src.themeMode)
    ? src.themeMode
    : APPEARANCE_DEFAULTS.themeMode;
  const accent = normalizeAccent(src.accent) || APPEARANCE_DEFAULTS.accent;
  let sunrise = normalizeTime(src.sunrise, APPEARANCE_DEFAULTS.sunrise);
  let sunset = normalizeTime(src.sunset, APPEARANCE_DEFAULTS.sunset);
  if (parseClock(sunrise).minutesOfDay >= parseClock(sunset).minutesOfDay) {
    sunrise = APPEARANCE_DEFAULTS.sunrise;
    sunset = APPEARANCE_DEFAULTS.sunset;
  }
  return { themeMode, accent, sunrise, sunset };
}

/** GitHub 仓库 "owner/repo" 规范化；非法返回 null。 */
function normalizeUpdateRepo(value) {
  if (typeof value !== 'string') return null;
  const text = value
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(text)) {
    return null;
  }
  return text;
}

/** lastSeenVersion：合法 semver 取其 norm，否则空字符串。 */
function sanitizeLastSeenVersion(value) {
  if (typeof value !== 'string') return '';
  const parsed = parseSemver(value);
  return parsed ? versionText(parsed) : '';
}

// ---- 语义化版本 -----------------------------------------------------------

const SEMVER_RE =
  /^[vV]?\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** 解析 "1.4.0" / "v1.4" / "1.4.0-beta.1"；非法返回 null。 */
function parseSemver(input) {
  if (typeof input !== 'string') return null;
  const match = SEMVER_RE.exec(input.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2] || 0),
    patch: Number(match[3] || 0),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

/** 规范化版本文本（去掉 v 前缀、补齐 minor/patch）。 */
function versionText(parsed) {
  const base = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  return parsed.prerelease.length ? `${base}-${parsed.prerelease.join('.')}` : base;
}

/**
 * 语义化版本比较：a < b 返回 -1，相等 0，a > b 返回 1。
 * 无法解析的版本视为最小（两边都非法时相等）。
 */
function compareVersions(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (!left.prerelease.length && !right.prerelease.length) return 0;
  // 正式版 > 预发布版
  if (!left.prerelease.length) return 1;
  if (!right.prerelease.length) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const l = left.prerelease[index];
    const r = right.prerelease[index];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const lNum = /^\d+$/.test(l) ? Number(l) : null;
    const rNum = /^\d+$/.test(r) ? Number(r) : null;
    if (lNum !== null && rNum !== null) {
      if (lNum !== rNum) return lNum < rNum ? -1 : 1;
    } else if (lNum !== null) {
      return -1; // 数字标识符 < 字母标识符
    } else if (rNum !== null) {
      return 1;
    } else if (l !== r) {
      return l < r ? -1 : 1;
    }
  }
  return 0;
}

/** latest 是否比 current 新。 */
function isNewerVersion(latest, current) {
  return compareVersions(latest, current) > 0;
}

/** 把 GitHub release JSON 映射成统一的更新检查结果。 */
function updateResultFromRelease(release, currentVersion, repo = DEFAULT_UPDATE_REPO) {
  const currentParsed = parseSemver(currentVersion);
  const current = currentParsed ? versionText(currentParsed) : String(currentVersion || '');
  const base = { currentVersion: current, latestVersion: null, url: null };
  if (!release || typeof release !== 'object' || Array.isArray(release)) {
    return {
      ...base,
      status: 'error',
      message: '更新检查失败：返回数据格式异常。',
    };
  }
  const tag =
    typeof release.tag_name === 'string'
      ? release.tag_name
      : typeof release.name === 'string'
        ? release.name
        : '';
  const parsed = parseSemver(tag);
  if (!parsed) {
    return {
      ...base,
      status: 'error',
      message: '更新检查失败：无法解析最新版本号。',
    };
  }
  const latestVersion = versionText(parsed);
  const htmlUrl =
    typeof release.html_url === 'string' && /^https?:\/\/\S+$/.test(release.html_url)
      ? release.html_url
      : `https://github.com/${repo}/releases`;
  if (isNewerVersion(latestVersion, current)) {
    return {
      ...base,
      status: 'update',
      latestVersion,
      url: htmlUrl,
      message: `发现新版本 v${latestVersion}`,
    };
  }
  return {
    ...base,
    status: 'latest',
    latestVersion,
    url: htmlUrl,
    message: `已是最新版本 v${current}`,
  };
}

/** 把常见的更新检查失败原因映射成清晰的中文消息（不抛异常）。 */
function updateErrorResult(kind, detail, currentVersion) {
  const currentParsed = parseSemver(currentVersion);
  const current = currentParsed ? versionText(currentParsed) : String(currentVersion || '');
  const messages = {
    disabled: '更新检查已禁用（离线/测试环境）。',
    offline: '更新检查已禁用（离线/测试环境）。',
    notfound: '更新检查失败：仓库还没有发布 Release（HTTP 404）。',
    forbidden: '更新检查失败：GitHub API 访问受限或超出频率限制（HTTP 403），请稍后重试。',
    ratelimit: '更新检查失败：GitHub API 访问受限或超出频率限制（HTTP 403），请稍后重试。',
    network: '更新检查失败：网络连接失败，请检查网络后重试。',
    timeout: '更新检查失败：请求超时，请检查网络后重试。',
    malformed: '更新检查失败：返回数据格式异常。',
    norepo: '更新检查失败：更新源必须是 owner/repo 形式的 GitHub 仓库。',
  };
  let message = messages[kind];
  if (!message) {
    message =
      kind === 'http'
        ? `更新检查失败：GitHub API 返回 HTTP ${detail}。`
        : '更新检查失败：未知错误。';
  }
  return {
    status: 'error',
    currentVersion: current,
    latestVersion: null,
    url: null,
    message,
  };
}

// ---- 喝水记录（water-state.json） ----------------------------------------

function sanitizeWaterRecord(value) {
  if (!value || typeof value !== 'object') return null;
  const atParsed = parseClock(value.at);
  const ml = toInteger(value.ml);
  if (!atParsed || ml === null || ml <= 0 || ml > WATER_RECORD_MAX_ML) return null;
  return { at: formatClock(atParsed), ml };
}

/**
 * 容错规范化喝水状态。
 *  - day 不是今天 -> 立即重置为空（跨天自动清零）。
 *  - records 中非法项被丢弃；totalMl 以 records 之和为准。
 *  - 若没有 records 但有历史 totalMl（兼容手写文件），保留 totalMl。
 */
function sanitizeWaterState(value, today = dayKey(new Date())) {
  const src = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  if (src.day !== today) return { day: today, totalMl: 0, records: [] };
  const records = [];
  if (Array.isArray(src.records)) {
    for (const raw of src.records) {
      const record = sanitizeWaterRecord(raw);
      if (record) records.push(record);
    }
  }
  let totalMl = records.reduce((sum, record) => sum + record.ml, 0);
  if (records.length === 0) {
    const legacy = toInteger(src.totalMl);
    if (legacy !== null && legacy > 0) {
      totalMl = Math.min(legacy, WATER_TOTAL_MAX_ML);
    }
  }
  return { day: today, totalMl, records };
}

/** 追加一条喝水记录；ml 非法返回 null。跨天自动重置。 */
function addWaterRecord(state, ml, now = new Date()) {
  const day = dayKey(now);
  const base = sanitizeWaterState(state, day);
  const amount = toInteger(ml);
  if (amount === null || amount < WATER_AMOUNT_MIN || amount > WATER_AMOUNT_MAX) {
    return null;
  }
  const at = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  return {
    day,
    totalMl: base.totalMl + amount,
    records: [...base.records, { at, ml: amount }],
  };
}

/** 清空指定日期的喝水记录。 */
function clearWaterState(now = new Date()) {
  return { day: dayKey(now), totalMl: 0, records: [] };
}

/** 今日喝水进度：百分比封顶 100（进度条不会溢出）。 */
function waterProgress(totalMl, goalMl) {
  const total = Number.isFinite(totalMl) ? Math.max(0, Math.round(totalMl)) : 0;
  const goal = normalizeBoundedInt(
    goalMl,
    WATER_LIMITS.goal[0],
    WATER_LIMITS.goal[1],
    WATER_DEFAULTS.goalMl,
  );
  return {
    totalMl: total,
    goalMl: goal,
    percent: Math.min(100, Math.round((total / goal) * 100)),
    reached: total >= goal,
  };
}

// ---- 提醒调度（纯函数：由主进程的 1s tick 驱动） --------------------------

/** now 是否位于「工作日 + [workStart, workEnd)」。休息日一律 false。 */
function isWithinWorkHours(settingsValue, now = new Date()) {
  const s =
    settingsValue && settingsValue.restMode
      ? settingsValue
      : sanitizeSettings(settingsValue, now);
  if (restDaysForWeek(s, now).includes(now.getDay())) return false;
  const start = parseClock(s.workStart);
  const end = parseClock(s.workEnd);
  if (!start || !end) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  return (
    minutes >= start.minutesOfDay && minutes < end.minutesOfDay
  );
}

/** 该提醒现在是否允许触发（开关 + 可选的仅工作时间限制）。 */
function reminderEligible(config, settingsValue, now = new Date()) {
  const cfg = config && typeof config === 'object' ? config : {};
  if (cfg.enabled !== true) return false;
  if (cfg.workHoursOnly === false) return true;
  return isWithinWorkHours(settingsValue, now);
}

/**
 * 是否到点该提醒。
 * baselineMs / baselineDay 由主进程维护：启动、保存设置、跨天、离开工作时间
 * 都会把 baseline 重置为当前时刻，避免一启动就补发。
 */
function reminderDue(config, settingsValue, now, baselineMs, baselineDay) {
  if (!Number.isFinite(baselineMs)) return false;
  if (typeof baselineDay !== 'string' || baselineDay !== dayKey(now)) return false;
  if (!reminderEligible(config, settingsValue, now)) return false;
  const interval = normalizeBoundedInt(
    config && config.intervalMinutes,
    WATER_LIMITS.interval[0],
    WATER_LIMITS.interval[1],
    45,
  );
  return now.getTime() - baselineMs >= interval * 60000;
}

/** 提醒通知文案（纯函数，便于单测）。 */
function reminderNotification(kind, config) {
  const cfg = config && typeof config === 'object' ? config : {};
  if (kind === 'rest') {
    const duration = normalizeBoundedInt(
      cfg.durationMinutes,
      REST_LIMITS.duration[0],
      REST_LIMITS.duration[1],
      REST_DEFAULTS.durationMinutes,
    );
    return {
      title: '休息提醒',
      body: `该休息一下了 · 起身活动 ${duration} 分钟`,
    };
  }
  return {
    title: '喝水提醒',
    body: '该喝水了 · 起身接杯水，补充点水分。',
  };
}

// ---- 主题解析 -------------------------------------------------------------

/**
 * 解析实际生效的浅色/深色主题。
 *  - system：跟随 Electron nativeTheme（调用方传入 systemPrefersDark）。
 *  - sun：日出~日落之间为浅色，其余深色（时间由用户配置，属近似值）。
 *  - light/dark：强制。
 */
function resolveTheme(appearance, now = new Date(), systemPrefersDark = false) {
  const a = sanitizeAppearance(appearance);
  if (a.themeMode === 'light' || a.themeMode === 'dark') return a.themeMode;
  if (a.themeMode === 'system') return systemPrefersDark ? 'dark' : 'light';
  const sunrise = parseClock(a.sunrise).minutesOfDay;
  const sunset = parseClock(a.sunset).minutesOfDay;
  if (sunrise >= sunset) return systemPrefersDark ? 'dark' : 'light';
  const minutes = now.getHours() * 60 + now.getMinutes();
  return minutes >= sunrise && minutes < sunset ? 'light' : 'dark';
}

// ---- 首次启动 / 版本变化自动打开设置 --------------------------------------

/**
 * 是否需要自动打开设置窗口：没有设置文件（首次安装），或 lastSeenVersion
 * 与当前版本不同（升级后首次启动）。自检时永远不打开。
 */
function shouldAutoOpenSettings(options) {
  const src = options && typeof options === 'object' ? options : {};
  if (src.selftest === true) return false;
  if (!src.hadSettingsFile) return true;
  const appVersion = typeof src.appVersion === 'string' ? src.appVersion.trim() : '';
  if (!appVersion) return false;
  const seen =
    typeof src.lastSeenVersion === 'string' ? src.lastSeenVersion.trim() : '';
  return seen !== appVersion;
}

const DEFAULT_SETTINGS = Object.freeze({
  workStart: '09:00',
  workEnd: '18:00',
  restMode: 'double',
  customRestDays: Object.freeze([0, 6]),
  alternating: Object.freeze({
    anchorDate: mondayKey(new Date()),
    anchorIsDouble: true,
  }),
  weeklyPlan: Object.freeze({}),
  lunch: Object.freeze({ enabled: true, start: '12:00', end: '13:00' }),
  overtime: Object.freeze({ enabled: true, start: '18:00' }),
  notifyAtEnd: true,
  notifyBeforeMinutes: 0,
  launchAtLogin: false,
  water: WATER_DEFAULTS,
  rest: REST_DEFAULTS,
  appearance: APPEARANCE_DEFAULTS,
  updateRepo: DEFAULT_UPDATE_REPO,
  lastSeenVersion: '',
});

/** 容错地把未知 JSON 规范成完整设置对象（缺字段/类型错误都回退默认值）。 */
function sanitizeSettings(input, now = new Date()) {
  const src = input && typeof input === 'object' ? input : {};
  const notifyAtEnd =
    typeof src.notifyAtEnd === 'boolean'
      ? src.notifyAtEnd
      : typeof src.notify === 'boolean'
        ? src.notify // 旧版字段迁移
        : DEFAULT_SETTINGS.notifyAtEnd;
  const before = normalizeNotifyBeforeMinutes(src.notifyBeforeMinutes);
  const workEnd = normalizeTime(src.workEnd, DEFAULT_SETTINGS.workEnd);
  return {
    workStart: normalizeTime(src.workStart, DEFAULT_SETTINGS.workStart),
    workEnd,
    restMode: REST_MODES.includes(src.restMode) ? src.restMode : DEFAULT_SETTINGS.restMode,
    customRestDays: normalizeCustomRestDays(src.customRestDays),
    alternating: sanitizeAlternating(src.alternating, now),
    weeklyPlan: sanitizeWeeklyPlan(src.weeklyPlan),
    lunch: sanitizeLunch(src.lunch),
    overtime: sanitizeOvertime(src.overtime, workEnd),
    notifyAtEnd,
    notifyBeforeMinutes: before === null ? DEFAULT_SETTINGS.notifyBeforeMinutes : before,
    launchAtLogin:
      typeof src.launchAtLogin === 'boolean'
        ? src.launchAtLogin
        : DEFAULT_SETTINGS.launchAtLogin,
    water: sanitizeWaterSettings(src.water),
    rest: sanitizeRestSettings(src.rest),
    appearance: sanitizeAppearance(src.appearance),
    updateRepo: normalizeUpdateRepo(src.updateRepo) || DEFAULT_UPDATE_REPO,
    lastSeenVersion: sanitizeLastSeenVersion(src.lastSeenVersion),
  };
}

/**
 * 保存前校验。返回 { ok: true, settings } 或 { ok: false, error }。
 * 只有通过校验的设置才会被写入磁盘。
 */
function validateSettings(input, now = new Date()) {
  const src = input && typeof input === 'object' ? input : {};

  const times = validateTimes(src.workStart, src.workEnd);
  if (!times.ok) return times;

  if (!REST_MODES.includes(src.restMode)) {
    return { ok: false, error: '请选择有效的休息日模式（双休/单休/大小休/自定义）。' };
  }

  if (src.restMode === 'custom') {
    if (
      !Array.isArray(src.customRestDays) ||
      !src.customRestDays.every(
        (day) => Number.isInteger(day) && day >= 0 && day <= 6,
      )
    ) {
      return { ok: false, error: '自定义休息日无效，请重新勾选周一至周日。' };
    }
  }

  if (src.restMode === 'alternating') {
    const alt = src.alternating;
    if (
      !alt ||
      typeof alt !== 'object' ||
      !parseDateKey(alt.anchorDate) ||
      typeof alt.anchorIsDouble !== 'boolean'
    ) {
      return { ok: false, error: '大小休设置无效，请重新勾选「本周为双休周」。' };
    }
  }

  if (src.weeklyPlan !== undefined && src.weeklyPlan !== null) {
    if (
      typeof src.weeklyPlan !== 'object' ||
      Array.isArray(src.weeklyPlan)
    ) {
      return { ok: false, error: '周排班设置无效，请重新选择每周的双休/单休。' };
    }
    for (const [key, plan] of Object.entries(src.weeklyPlan)) {
      if (!parseDateKey(key)) {
        return { ok: false, error: '周排班日期无效，请重新选择每周的双休/单休。' };
      }
      if (!WEEK_PLANS.includes(plan)) {
        return {
          ok: false,
          error: '周排班的休息安排无效，请重新选择双休或单休。',
        };
      }
    }
  }

  if (src.overtime !== undefined && src.overtime !== null) {
    const overtime = src.overtime;
    if (typeof overtime !== 'object' || Array.isArray(overtime)) {
      return { ok: false, error: '加班设置无效，请重新填写。' };
    }
    if (typeof overtime.enabled !== 'boolean') {
      return { ok: false, error: '加班计时开关无效，请重新勾选。' };
    }
    if (!parseClock(overtime.start)) {
      return {
        ok: false,
        error: '加班起算时间格式无效，请使用 24 小时制 HH:MM。',
      };
    }
  }

  const lunch = src.lunch;
  if (!lunch || typeof lunch !== 'object' || typeof lunch.enabled !== 'boolean') {
    return { ok: false, error: '午休设置无效，请重新填写。' };
  }
  if (lunch.enabled) {
    const lunchStart = parseClock(lunch.start);
    const lunchEnd = parseClock(lunch.end);
    if (!lunchStart) {
      return { ok: false, error: '午休开始时间格式无效，请使用 24 小时制 HH:MM。' };
    }
    if (!lunchEnd) {
      return { ok: false, error: '午休结束时间格式无效，请使用 24 小时制 HH:MM。' };
    }
    if (lunchEnd.minutesOfDay <= lunchStart.minutesOfDay) {
      return { ok: false, error: '午休结束时间必须晚于开始时间（不支持跨天午休）。' };
    }
  }

  if (typeof src.notifyAtEnd !== 'boolean') {
    return { ok: false, error: '通知设置无效，请重新勾选「下班时通知」。' };
  }
  if (normalizeNotifyBeforeMinutes(src.notifyBeforeMinutes) === null) {
    return {
      ok: false,
      error: '提前提醒分钟数必须是 0–120 的整数（0 表示不提醒）。',
    };
  }

  const waterError = validateWaterSettings(src.water);
  if (waterError) return { ok: false, error: waterError };

  const restError = validateRestSettings(src.rest);
  if (restError) return { ok: false, error: restError };

  const appearanceError = validateAppearance(src.appearance);
  if (appearanceError) return { ok: false, error: appearanceError };

  if (src.updateRepo !== undefined && src.updateRepo !== null) {
    if (normalizeUpdateRepo(src.updateRepo) === null) {
      return {
        ok: false,
        error:
          '更新源必须是 owner/repo 形式的 GitHub 仓库（例如 BALLBALLUUUUU/WORK-OR-RUN）。',
      };
    }
  }

  return { ok: true, settings: sanitizeSettings(src, now) };
}

function validateBooleanField(value, message) {
  if (value === undefined || value === null) return null;
  return typeof value === 'boolean' ? null : message;
}

function validateIntField(value, min, max, message) {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    return message;
  }
  return null;
}

function validateWaterSettings(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    return '喝水提醒设置无效，请重新填写。';
  }
  return (
    validateBooleanField(value.enabled, '喝水提醒开关无效，请重新勾选。') ||
    validateBooleanField(
      value.workHoursOnly,
      '「仅工作时间提醒」开关无效，请重新勾选。',
    ) ||
    validateIntField(
      value.intervalMinutes,
      WATER_LIMITS.interval[0],
      WATER_LIMITS.interval[1],
      '喝水提醒间隔必须是 1–600 的整数（分钟）。',
    ) ||
    validateIntField(
      value.goalMl,
      WATER_LIMITS.goal[0],
      WATER_LIMITS.goal[1],
      '每日喝水目标必须是 100–10000 的整数（ml）。',
    ) ||
    validateIntField(
      value.cupMl,
      WATER_LIMITS.cup[0],
      WATER_LIMITS.cup[1],
      '每次喝水量必须是 50–2000 的整数（ml）。',
    )
  );
}

function validateRestSettings(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    return '休息提醒设置无效，请重新填写。';
  }
  return (
    validateBooleanField(value.enabled, '休息提醒开关无效，请重新勾选。') ||
    validateBooleanField(
      value.workHoursOnly,
      '「仅工作时间提醒」开关无效，请重新勾选。',
    ) ||
    validateIntField(
      value.intervalMinutes,
      REST_LIMITS.interval[0],
      REST_LIMITS.interval[1],
      '休息提醒间隔必须是 1–600 的整数（分钟）。',
    ) ||
    validateIntField(
      value.durationMinutes,
      REST_LIMITS.duration[0],
      REST_LIMITS.duration[1],
      '每次休息时间必须是 1–120 的整数（分钟）。',
    )
  );
}

function validateAppearance(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    return '外观设置无效，请重新填写。';
  }
  if (value.themeMode !== undefined && !THEME_MODES.includes(value.themeMode)) {
    return '请选择有效的主题模式（跟随系统/跟随日出日落/浅色/深色）。';
  }
  if (
    value.accent !== undefined &&
    value.accent !== null &&
    normalizeAccent(value.accent) === null
  ) {
    return '高亮颜色必须是合法的十六进制颜色（如 #F5A65B）。';
  }
  if (value.sunrise !== undefined && value.sunrise !== null && !parseClock(value.sunrise)) {
    return '日出时间格式无效，请使用 24 小时制 HH:MM。';
  }
  if (value.sunset !== undefined && value.sunset !== null && !parseClock(value.sunset)) {
    return '日落时间格式无效，请使用 24 小时制 HH:MM。';
  }
  if (
    parseClock(value.sunrise) &&
    parseClock(value.sunset) &&
    parseClock(value.sunrise).minutesOfDay >= parseClock(value.sunset).minutesOfDay
  ) {
    return '日出时间必须早于日落时间。';
  }
  return null;
}

/**
 * 保存前校验班次时间。当前只支持同一天内的班次（下班时间必须晚于上班时间）。
 * 返回 { ok: true } 或 { ok: false, error }。
 */
function validateTimes(workStart, workEnd) {
  const start = parseClock(workStart);
  const end = parseClock(workEnd);
  if (!start) return { ok: false, error: '上班时间格式无效，请使用 24 小时制 HH:MM。' };
  if (!end) return { ok: false, error: '下班时间格式无效，请使用 24 小时制 HH:MM。' };
  if (end.minutesOfDay === start.minutesOfDay) {
    return { ok: false, error: '上班时间和下班时间不能相同。' };
  }
  if (end.minutesOfDay < start.minutesOfDay) {
    return { ok: false, error: '暂不支持跨天班次：下班时间需要晚于上班时间。' };
  }
  return { ok: true };
}

/** 毫秒 → "HH:MM:SS"；向上取整，避免结束前一秒显示 00:00:00。 */
function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
}

/** 按 周一…周日 的顺序把星期数字格式化成「周三、周五」。 */
function formatRestDays(days) {
  const ordered = [...new Set(days)].sort(
    (a, b) => ((a + 6) % 7) - ((b + 6) % 7),
  );
  return ordered.map((day) => WEEKDAY_NAMES[day]).join('、');
}

/** 当前周的休息日列表（已按星期排序）。 */
function restDaysForWeek(settings, now = new Date()) {
  const s = settings && settings.restMode ? settings : sanitizeSettings(settings, now);
  switch (s.restMode) {
    case 'single':
      return [0];
    case 'alternating':
      return alternatingWeekIsDouble(s.alternating, now) ? [0, 6] : [0];
    case 'monthly':
      return resolveWeekPlan(s, now) === 'double' ? [0, 6] : [0];
    case 'custom':
      return Array.isArray(s.customRestDays) ? [...s.customRestDays] : [0, 6];
    case 'double':
    default:
      return [0, 6];
  }
}

/** 菜单里的休息日说明（纯函数，便于单测）。 */
function describeRest(settings, now = new Date()) {
  const s = settings && settings.restMode ? settings : sanitizeSettings(settings, now);
  if (s.restMode === 'alternating') {
    return `本周：${alternatingWeekLabel(s.alternating, now)}`;
  }
  if (s.restMode === 'monthly') return monthlyWeekSummary(s, now);
  if (s.restMode === 'double') return '双休 · 周六、周日休息';
  if (s.restMode === 'single') return '单休 · 周日休息';
  const text = formatRestDays(Array.isArray(s.customRestDays) ? s.customRestDays : []);
  return text ? `自定义休息日 · ${text}` : '自定义休息日 · 无';
}

/**
 * 计算某一时刻的状态。
 * state: 'countdown' 倒计时中 | 'lunch' 午休中 | 'done' 今天已下班 | 'rest' 今天休息
 */
function computeStatus(settings, now = new Date()) {
  const s = sanitizeSettings(settings, now);
  const endClock = parseClock(s.workEnd);
  const day = now.getDay(); // 0 = 周日, 6 = 周六
  const restDays = restDaysForWeek(s, now);
  const isRest = restDays.includes(day);
  const isWeekendRest = isRest && (day === 0 || day === 6);
  const isAlternating = s.restMode === 'alternating';
  const doubleAlternating = isAlternating
    ? alternatingWeekIsDouble(s.alternating, now)
    : null;
  const isMonthly = s.restMode === 'monthly';
  const monthlyPlan = isMonthly ? resolveWeekPlan(s, now) : null;
  const monthlyWeek = isMonthly
    ? weeksOfMonth(now.getFullYear(), now.getMonth(), now).find(
        (week) => week.isCurrent,
      ) || null
    : null;
  const lunchEnabled = s.lunch.enabled;

  const target = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    endClock.hours,
    endClock.minutes,
    0,
    0,
  );
  const workRemainingMs = target.getTime() - now.getTime();

  const lunchStartClock = parseClock(s.lunch.start);
  const lunchEndClock = parseClock(s.lunch.end);
  const lunchStartAt = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    lunchStartClock.hours,
    lunchStartClock.minutes,
    0,
    0,
  );
  const lunchEndAt = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    lunchEndClock.hours,
    lunchEndClock.minutes,
    0,
    0,
  );
  const inLunch =
    lunchEnabled &&
    now.getTime() >= lunchStartAt.getTime() &&
    now.getTime() < lunchEndAt.getTime();
  const lunch = {
    enabled: lunchEnabled,
    start: s.lunch.start,
    end: s.lunch.end,
    active: inLunch,
    startRemainingMs:
      lunchEnabled && !inLunch && lunchStartAt.getTime() > now.getTime()
        ? lunchStartAt.getTime() - now.getTime()
        : null,
    remainingMs: inLunch ? lunchEndAt.getTime() - now.getTime() : null,
  };

  const common = {
    workStart: s.workStart,
    workEnd: s.workEnd,
    restMode: s.restMode,
    restModeName: REST_MODE_NAMES[s.restMode],
    restDays,
    restDescription: describeRest(s, now),
    alternatingWeek: isAlternating ? (doubleAlternating ? 'double' : 'single') : null,
    alternatingLabel: isAlternating
      ? doubleAlternating
        ? '双休周'
        : '单休周'
      : null,
    monthlyWeekPlan: monthlyPlan,
    monthlyWeekIndex: monthlyWeek ? monthlyWeek.index : null,
    isWorkday: !isRest,
    isWeekendRest,
    lunch,
    dayKey: dayKey(now),
    target,
    workRemainingMs,
  };

  if (isRest) {
    return {
      ...common,
      state: 'rest',
      title: isWeekendRest ? '周末愉快' : '今天休息',
      header: isWeekendRest ? '周末愉快 · 今天不用上班' : '今天休息 · 不用上班',
      remainingMs: 0,
      workRemainingMs: 0,
      target: null,
    };
  }

  // 下班时间优先：即使午休窗口跨过下班时间，也显示「已下班」。
  if (workRemainingMs <= 0) {
    return {
      ...common,
      state: 'done',
      title: '已下班',
      header: `已下班 · ${s.workEnd} 后好好休息`,
      remainingMs: 0,
    };
  }

  if (inLunch) {
    const text = formatDuration(lunch.remainingMs);
    return {
      ...common,
      state: 'lunch',
      title: `午休中 ${text}`,
      header: `午休中 · 距下午上班 ${text}`,
      remainingMs: lunch.remainingMs,
    };
  }

  const text = formatDuration(workRemainingMs);
  return {
    ...common,
    state: 'countdown',
    title: `距下班 ${text}`,
    header: `距下班 ${text}（${s.workStart}–${s.workEnd}）`,
    remainingMs: workRemainingMs,
  };
}

/**
 * 加班计时（纯函数）。
 * 返回 { enabled, state: 'idle' | 'counting', title, header, startAt, elapsedMs, dayKey }。
 *  - 仅工作日、且 now >= 当日起算时间时计时；
 *  - title 精确为「暂无加班」或「加班时长:HH:MM:SS」；
 *  - header 供主菜单的禁用详情行使用：`加班时长 01:23:45（19:00 起算）`；
 *  - startAt 始终是“今天”的起算时刻，跨过午夜后自然重置。
 */
function computeOvertime(settings, now = new Date()) {
  const s = sanitizeSettings(settings, now);
  const enabled = s.overtime.enabled;
  const startText = s.overtime.start;
  const startClock = parseClock(startText);
  const startAt = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    startClock.hours,
    startClock.minutes,
    0,
    0,
  );
  const isWorkday = !restDaysForWeek(s, now).includes(now.getDay());
  const counting =
    enabled && isWorkday && now.getTime() >= startAt.getTime();
  const elapsedMs = counting ? now.getTime() - startAt.getTime() : 0;
  const duration = formatDuration(elapsedMs);
  return {
    enabled,
    state: counting ? 'counting' : 'idle',
    title: counting ? `加班时长:${duration}` : '暂无加班',
    header: counting
      ? `加班时长 ${duration}（${startText} 起算）`
      : `暂无加班（${startText} 起算）`,
    startAt,
    elapsedMs,
    dayKey: dayKey(now),
  };
}

/**
 * 菜单栏主图标的状态色（纯函数）。
 * 返回 'work' | 'lunch' | 'overtime' | 'rest'，对应：
 *   work     #F5A65B 浅橙（工作日、非午休、未进入加班；含下班后到加班起算前）
 *   lunch    #8FD19E 浅绿（工作日、午休 [start, end) 内）
 *   overtime #E5533D 红（工作日、加班已开启且 now >= overtime.start）
 *   rest     #9AA4B2 灰蓝（今天休息）
 *
 * 冲突优先级：rest > overtime > lunch > work。即加班起算之后一律显示红色，
 * 即使异常配置下加班起算时间落在午休窗口内（computeOvertime 同样按时间计时）。
 * 边界：午休开始（含）→ lunch，午休结束（不含）→ work；加班起算（含）→ overtime。
 */
function trayAccentState(settings, now = new Date()) {
  const s = sanitizeSettings(settings, now);
  if (restDaysForWeek(s, now).includes(now.getDay())) return 'rest';

  const overtimeStart = parseClock(s.overtime.start);
  const overtimeAt = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    overtimeStart.hours,
    overtimeStart.minutes,
    0,
    0,
  );
  if (s.overtime.enabled && now.getTime() >= overtimeAt.getTime()) {
    return 'overtime';
  }

  if (s.lunch.enabled) {
    const lunchStart = parseClock(s.lunch.start);
    const lunchEnd = parseClock(s.lunch.end);
    const lunchStartAt = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      lunchStart.hours,
      lunchStart.minutes,
      0,
      0,
    );
    const lunchEndAt = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      lunchEnd.hours,
      lunchEnd.minutes,
      0,
      0,
    );
    if (
      now.getTime() >= lunchStartAt.getTime() &&
      now.getTime() < lunchEndAt.getTime()
    ) {
      return 'lunch';
    }
  }

  return 'work';
}

/**
 * 提前提醒阈值跨越（纯函数）：
 * 上一 tick 剩余 > N 分钟，当前 <= N 分钟且仍 > 0 时才返回 true。
 * previousRemainingMs 为 null/undefined（刚启动）时永远返回 false。
 */
function shouldNotifyBefore(settings, previousRemainingMs, currentRemainingMs) {
  const minutes = normalizeNotifyBeforeMinutes(
    settings && settings.notifyBeforeMinutes,
  );
  if (minutes === null || minutes <= 0) return false;
  if (
    !Number.isFinite(previousRemainingMs) ||
    !Number.isFinite(currentRemainingMs)
  ) {
    return false;
  }
  const threshold = minutes * 60000;
  return (
    previousRemainingMs > threshold &&
    currentRemainingMs <= threshold &&
    currentRemainingMs > 0
  );
}

/**
 * 根据前后两个状态计算本轮应该发出哪些通知（纯函数）。
 * 休息日 / 非工作日 / 刚启动（previous 为空）不会产生任何通知。
 */
function notificationEvents(settings, previous, current) {
  const events = { end: false, before: false };
  if (!previous || !current) return events;
  if (!previous.isWorkday || !current.isWorkday) return events;
  if (previous.state === 'rest' || current.state === 'rest') return events;
  const prev = previous.workRemainingMs;
  const curr = current.workRemainingMs;
  if (!Number.isFinite(prev) || !Number.isFinite(curr)) return events;

  const atEnd =
    settings && typeof settings.notifyAtEnd === 'boolean'
      ? settings.notifyAtEnd
      : true;
  if (atEnd && prev > 0 && curr <= 0) events.end = true;
  if (shouldNotifyBefore(settings, prev, curr)) events.before = true;
  return events;
}

module.exports = {
  DEFAULT_SETTINGS,
  REST_MODES,
  REST_MODE_NAMES,
  WEEKDAY_NAMES,
  WEEK_PLANS,
  NOTIFY_BEFORE_MAX,
  parseClock,
  normalizeTime,
  normalizeNotifyBeforeMinutes,
  sanitizeSettings,
  sanitizeWeeklyPlan,
  sanitizeOvertime,
  validateSettings,
  validateTimes,
  formatDuration,
  formatRestDays,
  dayKey,
  parseDateKey,
  mondayKey,
  alternatingWeekIsDouble,
  alternatingWeekLabel,
  resolveWeekPlan,
  weeksOfMonth,
  monthlyWeekSummary,
  restDaysForWeek,
  describeRest,
  computeStatus,
  computeOvertime,
  trayAccentState,
  shouldNotifyBefore,
  notificationEvents,
  // v1.4.0
  WATER_DEFAULTS,
  REST_DEFAULTS,
  APPEARANCE_DEFAULTS,
  THEME_MODES,
  ACCENT_PRESETS,
  DEFAULT_UPDATE_REPO,
  WATER_LIMITS,
  REST_LIMITS,
  WATER_AMOUNT_MIN,
  WATER_AMOUNT_MAX,
  WATER_RECORD_MAX_ML,
  toInteger,
  normalizeBoundedInt,
  normalizeAccent,
  sanitizeWaterSettings,
  sanitizeRestSettings,
  sanitizeAppearance,
  normalizeUpdateRepo,
  sanitizeLastSeenVersion,
  parseSemver,
  versionText,
  compareVersions,
  isNewerVersion,
  updateResultFromRelease,
  updateErrorResult,
  sanitizeWaterState,
  sanitizeWaterRecord,
  addWaterRecord,
  clearWaterState,
  waterProgress,
  isWithinWorkHours,
  reminderEligible,
  reminderDue,
  reminderNotification,
  resolveTheme,
  shouldAutoOpenSettings,
};
