'use strict';

/**
 * 设置窗口渲染进程（无 Node 访问权限，只通过 window.offwork 与主进程通信）。
 *
 * v1.4.0：
 *  - 五个标签页：倒计时 / 喝水提醒 / 休息提醒 / 设置 / 关于
 *  - 喝水记录（water-state.json）通过 IPC 读写，进度条即时更新
 *  - 高亮颜色实时预览、保存后持久化
 *  - 主题由主进程解析（system / 日出日落 / 浅色 / 深色）后推送，这里只应用
 *  - GitHub Releases 更新检查（异步、不阻塞界面）
 */

const api = window.offwork;
const $ = (id) => document.getElementById(id);

const TABS = ['countdown', 'water', 'rest', 'settings', 'about'];
const THEME_MODES = ['system', 'sun', 'light', 'dark'];
const ACCENT_PRESETS = [
  '#F5A65B',
  '#8FD19E',
  '#4A90D9',
  '#8E7CC3',
  '#E48FB3',
  '#E5533D',
];

let busy = false;
let meta = {};
/** 内存中的月排班：{ 'YYYY-MM-DD'(周一): 'double' | 'single' }；保存时才落盘。 */
let weekPlan = {};
let planYear = null;
let planMonth = null;
/** 当前生效的高亮色 / 主题（用于实时预览）。 */
let currentAccent = '#F5A65B';
let currentTheme = 'light';
/** 今日喝水状态（由主进程返回）。 */
let water = { day: '', totalMl: 0, records: [] };
let checkingUpdate = false;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function setMessage(text, kind) {
  const el = $('message');
  el.textContent = text || '';
  el.className = 'message';
  if (kind === 'ok') el.classList.add('ok');
  if (kind === 'error') el.classList.add('error');
}

// ---------------------------------------------------------------------------
// 主题与高亮颜色
// ---------------------------------------------------------------------------

function normalizeAccentLocal(value) {
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

function parseHex(value) {
  const normalized = normalizeAccentLocal(value) || '#F5A65B';
  return {
    r: parseInt(normalized.slice(1, 3), 16),
    g: parseInt(normalized.slice(3, 5), 16),
    b: parseInt(normalized.slice(5, 7), 16),
  };
}

function toHex(r, g, b) {
  return `#${[r, g, b]
    .map((channel) =>
      Math.max(0, Math.min(255, Math.round(channel)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')
    .toUpperCase()}`;
}

/** amount > 0 变亮，< 0 变暗。 */
function adjustColor(value, amount) {
  const { r, g, b } = parseHex(value);
  const target = amount >= 0 ? 255 : 0;
  const ratio = Math.abs(amount);
  return toHex(
    r + (target - r) * ratio,
    g + (target - g) * ratio,
    b + (target - b) * ratio,
  );
}

function applyAccent(value, options) {
  const settings = options && typeof options === 'object' ? options : {};
  const normalized = normalizeAccentLocal(value) || '#F5A65B';
  currentAccent = normalized;
  const { r, g, b } = parseHex(normalized);
  const root = document.documentElement;
  root.style.setProperty('--accent', normalized);
  root.style.setProperty(
    '--accent-strong',
    adjustColor(normalized, currentTheme === 'dark' ? 0.28 : -0.18),
  );
  root.style.setProperty(
    '--focus',
    `rgba(${r}, ${g}, ${b}, ${currentTheme === 'dark' ? 0.42 : 0.3})`,
  );
  if (settings.updatePicker !== false && $('accentCustom')) {
    $('accentCustom').value = normalized;
  }
  for (const swatch of document.querySelectorAll('.swatch')) {
    swatch.setAttribute(
      'aria-checked',
      String(
        String(swatch.dataset.accent || '').toUpperCase() === normalized,
      ),
    );
  }
}

function applyTheme(theme) {
  currentTheme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = currentTheme;
  applyAccent(currentAccent, { updatePicker: false });
}

function selectedTheme() {
  const checked = document.querySelector('input[name="themeMode"]:checked');
  return checked && THEME_MODES.includes(checked.value) ? checked.value : 'system';
}

function setThemeRadio(mode) {
  const value = THEME_MODES.includes(mode) ? mode : 'system';
  for (const input of document.querySelectorAll('input[name="themeMode"]')) {
    input.checked = input.value === value;
  }
}

function updateSunRows() {
  const sun = selectedTheme() === 'sun';
  $('sunriseRow').hidden = !sun;
  $('sunsetRow').hidden = !sun;
}

/** 询问主进程解析实际主题；IPC 不可用时用本地近似值兜底。 */
async function previewTheme() {
  const appearance = {
    themeMode: selectedTheme(),
    accent: normalizeAccentLocal($('accentCustom').value) || currentAccent,
    sunrise: $('sunrise').value || '06:30',
    sunset: $('sunset').value || '18:00',
  };
  try {
    if (api && typeof api.previewTheme === 'function') {
      const result = await api.previewTheme(appearance);
      if (result && result.theme) {
        applyTheme(result.theme);
        return;
      }
    }
  } catch {
    /* 忽略，走本地兜底 */
  }
  if (appearance.themeMode === 'light' || appearance.themeMode === 'dark') {
    applyTheme(appearance.themeMode);
    return;
  }
  if (appearance.themeMode === 'system') {
    applyTheme(meta.systemPrefersDark ? 'dark' : 'light');
    return;
  }
  const minutes = new Date().getHours() * 60 + new Date().getMinutes();
  const toMin = (text) => {
    const match = /^([0-9]{1,2}):([0-9]{2})$/.exec(String(text || ''));
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  };
  const rise = toMin(appearance.sunrise);
  const set = toMin(appearance.sunset);
  applyTheme(
    rise !== null && set !== null && rise < set && minutes >= rise && minutes < set
      ? 'light'
      : 'dark',
  );
}

// ---------------------------------------------------------------------------
// 标签页
// ---------------------------------------------------------------------------

function selectTab(name, focusTab) {
  const target = TABS.includes(name) ? name : 'countdown';
  for (const tab of document.querySelectorAll('.tab')) {
    const active = tab.dataset.tab === target;
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
    tab.tabIndex = active ? 0 : -1;
    if (active && focusTab) tab.focus();
  }
  for (const panel of document.querySelectorAll('.panel')) {
    panel.hidden = panel.dataset.panel !== target;
  }
  if (target === 'water') refreshWater();
}

function setupTabs() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => selectTab(tab.dataset.tab, false));
    tab.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const index = TABS.indexOf(tab.dataset.tab);
      const delta = event.key === 'ArrowRight' ? 1 : -1;
      const next = TABS[(index + delta + TABS.length) % TABS.length];
      selectTab(next, true);
    });
  }
}

// ---------------------------------------------------------------------------
// 月排班（与 countdown.js 的 weeksOfMonth 保持一致）
// ---------------------------------------------------------------------------

function dateKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function currentMondayKey(date = new Date()) {
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return dateKey(monday);
}

function mondayKeyOf(date) {
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return dateKey(monday);
}

/**
 * 与 countdown.js 的 weeksOfMonth 保持一致：枚举与指定月份相交的周一制周。
 * 返回 { index, monday, label, isCurrent }。
 */
function weeksOfMonthLocal(year, monthIndex) {
  const base = new Date(year, monthIndex, 1);
  const y = base.getFullYear();
  const m = base.getMonth();
  const first = new Date(y, m, 1);
  const last = new Date(y, m + 1, 0);
  const firstMonday = new Date(first);
  firstMonday.setDate(first.getDate() - ((first.getDay() + 6) % 7));
  const todayMonday = mondayKeyOf(new Date());
  const weeks = [];
  const cursor = new Date(firstMonday);
  while (cursor.getTime() <= last.getTime()) {
    const monday = new Date(cursor);
    const sunday = new Date(cursor);
    sunday.setDate(sunday.getDate() + 6);
    weeks.push({
      index: weeks.length + 1,
      monday: dateKey(monday),
      label: `第${weeks.length + 1}周 · ${pad2(monday.getMonth() + 1)}/${pad2(
        monday.getDate(),
      )}–${pad2(sunday.getMonth() + 1)}/${pad2(sunday.getDate())}`,
      isCurrent: dateKey(monday) === todayMonday,
    });
    cursor.setDate(cursor.getDate() + 7);
  }
  return weeks;
}

function renderPlanner() {
  if (planYear === null || planMonth === null) return;
  $('planTitle').textContent = `${planYear}年${planMonth + 1}月`;
  const container = $('planWeeks');
  container.textContent = '';
  for (const week of weeksOfMonthLocal(planYear, planMonth)) {
    const row = document.createElement('div');
    row.className = week.isCurrent ? 'plan-row current' : 'plan-row';

    const label = document.createElement('span');
    label.className = 'plan-label';
    label.textContent = week.label;

    const current = document.createElement('span');
    current.className = 'plan-current';
    current.textContent = week.isCurrent ? '本周' : '';

    const toggle = document.createElement('label');
    toggle.className = 'check plan-toggle';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.dataset.monday = week.monday;
    box.checked = weekPlan[week.monday] !== 'single';
    const text = document.createElement('span');
    text.textContent = box.checked ? '双休' : '单休';
    box.addEventListener('change', () => {
      // 只改内存，等「保存」时整份 weeklyPlan 一起写入。
      if (box.checked) weekPlan[week.monday] = 'double';
      else weekPlan[week.monday] = 'single';
      text.textContent = box.checked ? '双休' : '单休';
      setMessage('');
    });
    toggle.append(box, text);

    row.append(label, current, toggle);
    container.append(row);
  }
}

function shiftPlanMonth(delta) {
  const next = new Date(planYear, planMonth + delta, 1);
  planYear = next.getFullYear();
  planMonth = next.getMonth();
  renderPlanner();
}

function updateRestModeUi() {
  const mode = $('restMode').value;
  $('alternatingRow').hidden = mode !== 'alternating';
  $('customRow').hidden = mode !== 'custom';
  $('monthlyRow').hidden = mode !== 'monthly';
  if (mode === 'monthly') renderPlanner();
  const hints = {
    double: '周六、周日休息；休息日不显示倒计时，也不会发送通知。',
    single: '仅周日休息，周六按工作日计算。',
    alternating: '按周交替：双休周周六、周日休息；单休周仅周日休息。每周一自动切换。',
    monthly: '按月排班：逐周选择双休或单休；未配置的周按双休处理。',
    custom: '只有勾选的日子休息；未勾选的周末也按工作日计算。',
  };
  $('restHint').textContent = hints[mode] || hints.double;
}

function setCustomDays(days) {
  const set = new Set(Array.isArray(days) ? days.map(Number) : []);
  for (const input of document.querySelectorAll('input[name="customRestDay"]')) {
    input.checked = set.has(Number(input.value));
  }
}

function readCustomDays() {
  return Array.from(
    document.querySelectorAll('input[name="customRestDay"]:checked'),
  )
    .map((input) => Number(input.value))
    .sort((a, b) => a - b);
}

function updateLunchUi() {
  const enabled = $('lunchEnabled').checked;
  $('lunchStart').disabled = !enabled;
  $('lunchEnd').disabled = !enabled;
}

function updateOvertimeUi() {
  $('overtimeStart').disabled = !$('overtimeEnabled').checked;
}

// ---------------------------------------------------------------------------
// 喝水提醒 / 今日记录
// ---------------------------------------------------------------------------

function pendingGoal() {
  const n = Number($('waterGoal').value);
  return Number.isInteger(n) && n >= 100 && n <= 10000 ? n : 2000;
}

function pendingCup() {
  const n = Number($('waterCup').value);
  return Number.isInteger(n) && n >= 50 && n <= 2000 ? n : 250;
}

function updateWaterSummary() {
  const total = water && Number.isFinite(water.totalMl) ? Math.max(0, water.totalMl) : 0;
  const goal = pendingGoal();
  const percent = Math.min(100, Math.round((total / goal) * 100));
  $('waterTotal').textContent = String(total);
  $('waterGoalText').textContent = String(goal);
  $('waterPercent').textContent = `${percent}%`;
  $('waterProgressBar').style.width = `${percent}%`;
  $('waterProgress').setAttribute('aria-valuenow', String(percent));
  $('waterAddCup').textContent = `+1 次（${pendingCup()}ml）`;
}

function renderWater(state) {
  if (state && typeof state === 'object') {
    water = {
      day: typeof state.day === 'string' ? state.day : '',
      totalMl: Number.isFinite(state.totalMl) ? state.totalMl : 0,
      records: Array.isArray(state.records) ? state.records : [],
    };
  }
  const list = $('waterList');
  list.textContent = '';
  for (const record of water.records) {
    const row = document.createElement('li');
    row.className = 'water-row';
    const at = document.createElement('span');
    at.className = 'at';
    at.textContent = String(record.at || '');
    const ml = document.createElement('span');
    ml.className = 'ml';
    ml.textContent = `+${Number(record.ml) || 0} ml`;
    row.append(at, ml);
    list.append(row);
  }
  $('waterEmpty').hidden = water.records.length > 0;
  $('waterClear').disabled = water.records.length === 0;
  updateWaterSummary();
}

async function refreshWater() {
  if (!api || typeof api.getWater !== 'function') return;
  try {
    const result = await api.getWater();
    if (result && result.ok && result.state) renderWater(result.state);
  } catch {
    /* 喝水状态读取失败不阻塞设置窗口 */
  }
}

async function addWater(amount) {
  if (busy) return;
  const ml = Number(amount);
  if (!Number.isInteger(ml) || ml < 1 || ml > 2000) {
    setMessage('喝水量必须是 1–2000 的整数（ml）。', 'error');
    return;
  }
  try {
    const result = await api.recordWater(ml);
    if (!result || !result.ok) {
      setMessage((result && result.error) || '记录失败，请重试。', 'error');
      return;
    }
    renderWater(result.state);
    setMessage(`已记录 ${ml} ml`, 'ok');
  } catch (error) {
    setMessage(`记录失败：${error.message}`, 'error');
  }
}

async function clearWater() {
  if (busy) return;
  try {
    const result = await api.clearWater();
    if (!result || !result.ok) {
      setMessage((result && result.error) || '清空失败，请重试。', 'error');
      return;
    }
    renderWater(result.state);
    setMessage('已清空今日喝水记录', 'ok');
  } catch (error) {
    setMessage(`清空失败：${error.message}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// 更新检查
// ---------------------------------------------------------------------------

function setUpdateBusy(flag) {
  $('checkUpdateSettings').disabled = flag;
  $('checkUpdateAbout').disabled = flag;
  if (!flag) return;
  for (const id of ['updateResultSettings', 'updateResultAbout']) {
    const el = $(id);
    el.textContent = '正在检查…';
    el.className = 'update-result';
  }
  for (const id of ['releaseLinkSettings', 'releaseLinkAbout']) {
    const link = $(id);
    link.hidden = true;
    delete link.dataset.url;
  }
}

function renderUpdateResult(result) {
  const status = result && result.status ? result.status : 'error';
  let text = '检查失败，请稍后重试。';
  if (status === 'latest') {
    text = `已是最新版本 v${result.currentVersion || meta.version || ''}`;
  } else if (status === 'update') {
    text = `发现新版本 v${result.latestVersion}`;
  } else if (result && result.message) {
    text = result.message;
  }
  const className =
    status === 'latest' ? 'ok' : status === 'update' ? 'update' : 'error';
  for (const id of ['updateResultSettings', 'updateResultAbout']) {
    const el = $(id);
    el.textContent = text;
    el.className = `update-result ${className}`;
  }
  const showLink = status === 'update' && Boolean(result && result.url);
  for (const id of ['releaseLinkSettings', 'releaseLinkAbout']) {
    const link = $(id);
    link.hidden = !showLink;
    if (showLink) link.dataset.url = result.url;
    else delete link.dataset.url;
  }
}

async function checkUpdate() {
  if (checkingUpdate) return;
  checkingUpdate = true;
  setUpdateBusy(true);
  try {
    const result = await api.checkUpdate();
    renderUpdateResult(result);
  } catch (error) {
    renderUpdateResult({ status: 'error', message: `检查失败：${error.message}` });
  } finally {
    checkingUpdate = false;
    setUpdateBusy(false);
  }
}

async function openRelease(link) {
  const url = link && link.dataset ? link.dataset.url : '';
  if (!url) return;
  try {
    const result = await api.openRelease(url);
    if (!result || !result.ok) {
      setMessage((result && result.error) || '无法打开链接。', 'error');
    }
  } catch (error) {
    setMessage(`无法打开链接：${error.message}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// 读取 / 校验 / 保存
// ---------------------------------------------------------------------------

async function init() {
  if (!api) {
    setMessage('预加载脚本未生效，无法读取设置。', 'error');
    return;
  }
  try {
    const result = await api.load();
    const s = (result && result.settings) || {};
    meta = (result && result.meta) || {};

    currentAccent =
      normalizeAccentLocal(s.appearance && s.appearance.accent) || '#F5A65B';
    applyTheme(meta.theme === 'dark' ? 'dark' : 'light');
    $('accentCustom').value = currentAccent;

    $('workStart').value = s.workStart || '09:00';
    $('workEnd').value = s.workEnd || '18:00';
    $('restMode').value = s.restMode || 'double';
    setCustomDays(s.customRestDays);
    $('alternatingDouble').checked = Boolean(meta.alternatingIsDoubleThisWeek);
    weekPlan =
      s.weeklyPlan && typeof s.weeklyPlan === 'object' ? { ...s.weeklyPlan } : {};
    const now = new Date();
    planYear = now.getFullYear();
    planMonth = now.getMonth();
    $('lunchEnabled').checked = s.lunch ? Boolean(s.lunch.enabled) : true;
    $('lunchStart').value = (s.lunch && s.lunch.start) || '12:00';
    $('lunchEnd').value = (s.lunch && s.lunch.end) || '13:00';
    const overtime = s.overtime && typeof s.overtime === 'object' ? s.overtime : {};
    $('overtimeEnabled').checked =
      typeof overtime.enabled === 'boolean' ? overtime.enabled : true;
    $('overtimeStart').value = overtime.start || s.workEnd || '18:00';
    $('notifyAtEnd').checked = Boolean(s.notifyAtEnd);
    $('notifyBeforeMinutes').value = String(
      Number.isInteger(s.notifyBeforeMinutes) ? s.notifyBeforeMinutes : 0,
    );

    const w = s.water && typeof s.water === 'object' ? s.water : {};
    $('waterEnabled').checked = w.enabled !== false;
    $('waterInterval').value = String(
      Number.isInteger(w.intervalMinutes) ? w.intervalMinutes : 45,
    );
    $('waterGoal').value = String(Number.isInteger(w.goalMl) ? w.goalMl : 2000);
    $('waterCup').value = String(Number.isInteger(w.cupMl) ? w.cupMl : 250);
    $('waterWorkHoursOnly').checked = w.workHoursOnly !== false;

    const r = s.rest && typeof s.rest === 'object' ? s.rest : {};
    $('restEnabled').checked = r.enabled !== false;
    $('restInterval').value = String(
      Number.isInteger(r.intervalMinutes) ? r.intervalMinutes : 45,
    );
    $('restDuration').value = String(
      Number.isInteger(r.durationMinutes) ? r.durationMinutes : 5,
    );
    $('restWorkHoursOnly').checked = r.workHoursOnly !== false;

    const a = s.appearance && typeof s.appearance === 'object' ? s.appearance : {};
    setThemeRadio(a.themeMode || 'system');
    $('sunrise').value = a.sunrise || '06:30';
    $('sunset').value = a.sunset || '18:00';
    updateSunRows();
    applyAccent(currentAccent, { updatePicker: true });

    $('updateRepo').value =
      s.updateRepo || meta.defaultUpdateRepo || 'BALLBALLUUUUU/WORK-OR-RUN';

    const versionText = meta.version ? `v${meta.version}` : '-';
    $('metaVersion').textContent = versionText;
    $('settingsVersion').textContent = versionText;
    $('metaUserData').textContent = meta.userDataPath || '-';

    updateRestModeUi();
    updateLunchUi();
    updateOvertimeUi();
    updateWaterSummary();
    await refreshWater();
  } catch (error) {
    setMessage(`读取设置失败：${error.message}`, 'error');
  }
}

function intValue(id, min, max, message) {
  const raw = String($(id).value || '').trim();
  const value = Number(raw);
  if (raw === '' || !Number.isInteger(value) || value < min || value > max) {
    setMessage(message, 'error');
    return null;
  }
  return value;
}

function timeValue(id) {
  const raw = String($(id).value || '').trim();
  const match = /^([0-9]{1,2}):([0-9]{2})$/.exec(raw);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function localValidate() {
  const workStart = $('workStart').value.trim();
  const workEnd = $('workEnd').value.trim();
  if (!workStart || !workEnd) {
    setMessage('请填写上班时间和下班时间。', 'error');
    return null;
  }
  const start = timeValue('workStart');
  const end = timeValue('workEnd');
  if (start === null || end === null) {
    setMessage('时间格式无效，请使用 24 小时制 HH:MM。', 'error');
    return null;
  }
  if (end === start) {
    setMessage('上班时间和下班时间不能相同。', 'error');
    return null;
  }
  if (end < start) {
    setMessage('暂不支持跨天班次：下班时间需要晚于上班时间。', 'error');
    return null;
  }

  const lunchEnabled = $('lunchEnabled').checked;
  const lunchStart = $('lunchStart').value.trim();
  const lunchEnd = $('lunchEnd').value.trim();
  if (lunchEnabled) {
    const lunchStartMin = timeValue('lunchStart');
    const lunchEndMin = timeValue('lunchEnd');
    if (lunchStartMin === null || lunchEndMin === null) {
      setMessage('请填写有效的午休开始/结束时间。', 'error');
      return null;
    }
    if (lunchEndMin <= lunchStartMin) {
      setMessage('午休结束时间必须晚于开始时间（不支持跨天午休）。', 'error');
      return null;
    }
  }

  const beforeRaw = $('notifyBeforeMinutes').value.trim();
  const before = Number(beforeRaw);
  if (
    beforeRaw === '' ||
    !Number.isInteger(before) ||
    before < 0 ||
    before > 120
  ) {
    setMessage('提前提醒分钟数必须是 0–120 的整数（0 表示不提醒）。', 'error');
    return null;
  }

  // 加班：未勾选或留空时回退到当前下班时间；填写了就必须是合法时间。
  const overtimeEnabled = $('overtimeEnabled').checked;
  const overtimeStartRaw = $('overtimeStart').value.trim();
  const overtimeStart = overtimeStartRaw || workEnd;
  if (timeValue('overtimeStart') === null && overtimeStartRaw !== '') {
    setMessage('加班起算时间格式无效，请使用 24 小时制 HH:MM。', 'error');
    return null;
  }
  if (timeValue('overtimeStart') === null && overtimeStartRaw === '') {
    // 留空回退下班时间
  }

  // 喝水提醒
  const waterInterval = intValue(
    'waterInterval',
    1,
    600,
    '喝水提醒间隔必须是 1–600 的整数（分钟）。',
  );
  if (waterInterval === null) return null;
  const waterGoal = intValue(
    'waterGoal',
    100,
    10000,
    '每日喝水目标必须是 100–10000 的整数（ml）。',
  );
  if (waterGoal === null) return null;
  const waterCup = intValue(
    'waterCup',
    50,
    2000,
    '每次喝水量必须是 50–2000 的整数（ml）。',
  );
  if (waterCup === null) return null;

  // 休息提醒
  const restInterval = intValue(
    'restInterval',
    1,
    600,
    '休息提醒间隔必须是 1–600 的整数（分钟）。',
  );
  if (restInterval === null) return null;
  const restDuration = intValue(
    'restDuration',
    1,
    120,
    '每次休息时间必须是 1–120 的整数（分钟）。',
  );
  if (restDuration === null) return null;

  // 外观
  const themeMode = selectedTheme();
  const accent = normalizeAccentLocal($('accentCustom').value);
  if (!accent) {
    setMessage('高亮颜色必须是合法的十六进制颜色（如 #F5A65B）。', 'error');
    return null;
  }
  const sunrise = $('sunrise').value.trim() || '06:30';
  const sunset = $('sunset').value.trim() || '18:00';
  const sunriseMin = timeValue('sunrise');
  const sunsetMin = timeValue('sunset');
  if (sunriseMin === null) {
    setMessage('日出时间格式无效，请使用 24 小时制 HH:MM。', 'error');
    return null;
  }
  if (sunsetMin === null) {
    setMessage('日落时间格式无效，请使用 24 小时制 HH:MM。', 'error');
    return null;
  }
  if (sunriseMin >= sunsetMin) {
    setMessage('日出时间必须早于日落时间。', 'error');
    return null;
  }

  // 更新源
  const updateRepo = $('updateRepo').value.trim();
  if (
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(updateRepo)
  ) {
    setMessage(
      '更新源必须是 owner/repo 形式的 GitHub 仓库（例如 BALLBALLUUUUU/WORK-OR-RUN）。',
      'error',
    );
    return null;
  }

  return {
    workStart,
    workEnd,
    restMode: $('restMode').value,
    customRestDays: readCustomDays(),
    alternating: {
      anchorDate: currentMondayKey(new Date()),
      anchorIsDouble: $('alternatingDouble').checked,
    },
    weeklyPlan: { ...weekPlan },
    lunch: {
      enabled: lunchEnabled,
      start: lunchStart || '12:00',
      end: lunchEnd || '13:00',
    },
    overtime: {
      enabled: overtimeEnabled,
      start: overtimeStart,
    },
    notifyAtEnd: $('notifyAtEnd').checked,
    notifyBeforeMinutes: before,
    water: {
      enabled: $('waterEnabled').checked,
      intervalMinutes: waterInterval,
      goalMl: waterGoal,
      cupMl: waterCup,
      workHoursOnly: $('waterWorkHoursOnly').checked,
    },
    rest: {
      enabled: $('restEnabled').checked,
      intervalMinutes: restInterval,
      durationMinutes: restDuration,
      workHoursOnly: $('restWorkHoursOnly').checked,
    },
    appearance: { themeMode, accent, sunrise, sunset },
    updateRepo,
  };
}

async function save() {
  if (busy) return;
  setMessage('');
  const payload = localValidate();
  if (!payload) return;

  busy = true;
  $('save').disabled = true;
  setMessage('正在保存…');

  try {
    const result = await api.save(payload);
    if (!result || !result.ok) {
      setMessage((result && result.error) || '保存失败，请重试。', 'error');
      return;
    }
    if (result.settings) {
      const saved = result.settings;
      $('workStart').value = saved.workStart;
      $('workEnd').value = saved.workEnd;
      $('restMode').value = saved.restMode;
      setCustomDays(saved.customRestDays);
      weekPlan =
        saved.weeklyPlan && typeof saved.weeklyPlan === 'object'
          ? { ...saved.weeklyPlan }
          : {};
      $('lunchEnabled').checked = Boolean(saved.lunch.enabled);
      $('lunchStart').value = saved.lunch.start;
      $('lunchEnd').value = saved.lunch.end;
      const savedOvertime = saved.overtime || {};
      $('overtimeEnabled').checked = Boolean(savedOvertime.enabled);
      $('overtimeStart').value =
        savedOvertime.start || saved.workEnd || $('workEnd').value;
      $('notifyAtEnd').checked = Boolean(saved.notifyAtEnd);
      $('notifyBeforeMinutes').value = String(saved.notifyBeforeMinutes);

      const savedWater = saved.water || {};
      $('waterEnabled').checked = Boolean(savedWater.enabled);
      $('waterInterval').value = String(savedWater.intervalMinutes);
      $('waterGoal').value = String(savedWater.goalMl);
      $('waterCup').value = String(savedWater.cupMl);
      $('waterWorkHoursOnly').checked = Boolean(savedWater.workHoursOnly);

      const savedRest = saved.rest || {};
      $('restEnabled').checked = Boolean(savedRest.enabled);
      $('restInterval').value = String(savedRest.intervalMinutes);
      $('restDuration').value = String(savedRest.durationMinutes);
      $('restWorkHoursOnly').checked = Boolean(savedRest.workHoursOnly);

      const savedAppearance = saved.appearance || {};
      setThemeRadio(savedAppearance.themeMode);
      $('sunrise').value = savedAppearance.sunrise;
      $('sunset').value = savedAppearance.sunset;
      applyAccent(savedAppearance.accent, { updatePicker: true });
      $('updateRepo').value = saved.updateRepo;

      updateRestModeUi();
      updateLunchUi();
      updateOvertimeUi();
      updateWaterSummary();
      updateSunRows();
      await previewTheme();
    }
    setMessage('已保存', 'ok');
    setTimeout(() => {
      api.close();
    }, 260);
  } catch (error) {
    setMessage(`保存失败：${error.message}`, 'error');
  } finally {
    busy = false;
    $('save').disabled = false;
  }
}

// ---------------------------------------------------------------------------
// 事件绑定
// ---------------------------------------------------------------------------

$('form').addEventListener('submit', (event) => {
  event.preventDefault();
  save();
});

$('cancel').addEventListener('click', () => api && api.cancel());
$('restMode').addEventListener('change', updateRestModeUi);
$('lunchEnabled').addEventListener('change', updateLunchUi);
$('overtimeEnabled').addEventListener('change', updateOvertimeUi);
$('planPrev').addEventListener('click', () => shiftPlanMonth(-1));
$('planNext').addEventListener('click', () => shiftPlanMonth(1));
$('planToday').addEventListener('click', () => {
  const now = new Date();
  planYear = now.getFullYear();
  planMonth = now.getMonth();
  renderPlanner();
});

$('waterAddCup').addEventListener('click', () => addWater(pendingCup()));
for (const button of document.querySelectorAll('[data-water-ml]')) {
  button.addEventListener('click', () => addWater(button.dataset.waterMl));
}
$('waterAddCustom').addEventListener('click', () =>
  addWater($('waterCustomMl').value),
);
$('waterClear').addEventListener('click', clearWater);
$('waterGoal').addEventListener('input', updateWaterSummary);
$('waterCup').addEventListener('input', updateWaterSummary);

for (const swatch of document.querySelectorAll('.swatch')) {
  swatch.addEventListener('click', () => applyAccent(swatch.dataset.accent));
}
$('accentCustom').addEventListener('input', () => {
  applyAccent($('accentCustom').value, { updatePicker: false });
});

for (const input of document.querySelectorAll('input[name="themeMode"]')) {
  input.addEventListener('change', () => {
    updateSunRows();
    previewTheme();
  });
}
$('sunrise').addEventListener('change', previewTheme);
$('sunset').addEventListener('change', previewTheme);

$('checkUpdateSettings').addEventListener('click', checkUpdate);
$('checkUpdateAbout').addEventListener('click', checkUpdate);
$('releaseLinkSettings').addEventListener('click', (event) =>
  openRelease(event.currentTarget),
);
$('releaseLinkAbout').addEventListener('click', (event) =>
  openRelease(event.currentTarget),
);

// 主进程推送主题变化（跟随系统 / 日出日落跨过阈值时）
if (api && typeof api.onTheme === 'function') {
  api.onTheme((payload) => {
    if (payload && (payload.theme === 'light' || payload.theme === 'dark')) {
      applyTheme(payload.theme);
    }
  });
}

// Cmd+Enter 保存；Esc 取消（窗口内任意位置）
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    if (api) api.cancel();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    save();
  }
});

setupTabs();
selectTab('countdown', false);
init();
