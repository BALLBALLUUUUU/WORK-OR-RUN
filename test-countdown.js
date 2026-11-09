'use strict';

/**
 * countdown.js 的单元测试（纯 Node，不需要 Electron / GUI）。
 * 运行：node test-countdown.js
 */

const assert = require('node:assert/strict');
const {
  DEFAULT_SETTINGS,
  parseClock,
  parseDateKey,
  mondayKey,
  sanitizeSettings,
  sanitizeWeeklyPlan,
  sanitizeOvertime,
  validateSettings,
  validateTimes,
  formatDuration,
  formatRestDays,
  restDaysForWeek,
  describeRest,
  resolveWeekPlan,
  weeksOfMonth,
  monthlyWeekSummary,
  alternatingWeekIsDouble,
  computeStatus,
  computeOvertime,
  trayAccentState,
  dayKey,
  shouldNotifyBefore,
  notificationEvents,
  // v1.4.0
  WATER_DEFAULTS,
  REST_DEFAULTS,
  APPEARANCE_DEFAULTS,
  THEME_MODES,
  ACCENT_PRESETS,
  DEFAULT_UPDATE_REPO,
  parseSemver,
  versionText,
  compareVersions,
  isNewerVersion,
  updateResultFromRelease,
  updateErrorResult,
  normalizeAccent,
  sanitizeWaterSettings,
  sanitizeRestSettings,
  sanitizeAppearance,
  normalizeUpdateRepo,
  sanitizeLastSeenVersion,
  sanitizeWaterState,
  addWaterRecord,
  clearWaterState,
  waterProgress,
  isWithinWorkHours,
  reminderEligible,
  reminderDue,
  reminderNotification,
  resolveTheme,
  shouldAutoOpenSettings,
} = require('./countdown');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  }
}

/** 构造本地时间（月份从 0 开始）。 */
function local(y, m, d, hh = 0, mm = 0, ss = 0, ms = 0) {
  return new Date(y, m - 1, d, hh, mm, ss, ms);
}

// 2026-11-09 周一，2026-11-14 周六，2026-11-15 周日，
// 2026-11-16 周一，2026-11-21 周六，2026-11-22 周日。
const MONDAY = local(2026, 11, 9, 10, 0, 0);
const WEEK1_MONDAY = '2026-11-09';
const WEEK2_MONDAY = '2026-11-16';
const WEEK3_MONDAY = '2026-11-23';

/** 生成一份完整设置（默认再加覆盖项），时间基准为 2026-11-09。 */
function makeSettings(overrides = {}) {
  return sanitizeSettings(
    {
      workStart: '09:00',
      workEnd: '18:00',
      restMode: 'double',
      customRestDays: [0, 6],
      alternating: { anchorDate: WEEK1_MONDAY, anchorIsDouble: true },
      lunch: { enabled: true, start: '12:00', end: '13:00' },
      notifyAtEnd: true,
      notifyBeforeMinutes: 0,
      launchAtLogin: false,
      ...overrides,
    },
    MONDAY,
  );
}

function validPayload(overrides = {}) {
  return {
    workStart: '09:00',
    workEnd: '18:00',
    restMode: 'double',
    customRestDays: [0, 6],
    alternating: { anchorDate: WEEK1_MONDAY, anchorIsDouble: true },
    lunch: { enabled: true, start: '12:00', end: '13:00' },
    notifyAtEnd: true,
    notifyBeforeMinutes: 0,
    ...overrides,
  };
}

check('parseClock 接受合法值并规范化', () => {
  assert.deepEqual(parseClock('09:00'), { hours: 9, minutes: 0, minutesOfDay: 540 });
  assert.deepEqual(parseClock('9:05'), { hours: 9, minutes: 5, minutesOfDay: 545 });
  assert.equal(parseClock('24:00'), null);
  assert.equal(parseClock('12:60'), null);
  assert.equal(parseClock('abc'), null);
  assert.equal(parseClock(''), null);
  assert.equal(parseClock(null), null);
});

check('parseDateKey / mondayKey 处理周一起点与非法日期', () => {
  assert.equal(parseDateKey('2026-11-09').dayNumber, 20766);
  assert.equal(parseDateKey('2026-02-31'), null);
  assert.equal(parseDateKey('2026-1-9'), null);
  assert.equal(parseDateKey(null), null);
  assert.equal(mondayKey(local(2026, 11, 9)), WEEK1_MONDAY);
  assert.equal(mondayKey(local(2026, 11, 15)), WEEK1_MONDAY); // 周日属于同一周
  assert.equal(mondayKey(local(2026, 11, 16)), WEEK2_MONDAY);
});

check('legacy notify -> notifyAtEnd，workStart/workEnd 保留，旧字段移除', () => {
  const migrated = sanitizeSettings(
    { workStart: '10:00', workEnd: '19:00', notify: true, launchAtLogin: false },
    MONDAY,
  );
  assert.equal(migrated.workStart, '10:00');
  assert.equal(migrated.workEnd, '19:00');
  assert.equal(migrated.notifyAtEnd, true);
  assert.equal('notify' in migrated, false);
  assert.equal(migrated.notifyBeforeMinutes, 0);
  assert.equal(migrated.restMode, 'double');
  assert.deepEqual(migrated.customRestDays, [0, 6]);
  assert.deepEqual(migrated.lunch, { enabled: true, start: '12:00', end: '13:00' });
  assert.deepEqual(migrated.alternating, {
    anchorDate: WEEK1_MONDAY,
    anchorIsDouble: true,
  });
  assert.equal(
    sanitizeSettings({ notify: false }, MONDAY).notifyAtEnd,
    false,
  );
  // 新字段优先于旧字段
  assert.equal(
    sanitizeSettings({ notify: true, notifyAtEnd: false }, MONDAY).notifyAtEnd,
    false,
  );
});

check('缺失字段回退默认值，已有合法班次不被覆盖', () => {
  const defaults = sanitizeSettings({}, MONDAY);
  assert.equal(defaults.workStart, DEFAULT_SETTINGS.workStart);
  assert.equal(defaults.workEnd, DEFAULT_SETTINGS.workEnd);
  assert.equal(defaults.restMode, 'double');
  assert.deepEqual(defaults.customRestDays, [0, 6]);
  assert.equal(defaults.notifyAtEnd, true);
  assert.equal(defaults.notifyBeforeMinutes, 0);
  assert.equal(defaults.launchAtLogin, false);
  assert.equal(defaults.alternating.anchorDate, WEEK1_MONDAY);
  assert.deepEqual(defaults.lunch, { enabled: true, start: '12:00', end: '13:00' });

  const kept = sanitizeSettings({ workStart: '8:15', workEnd: '17:45' }, MONDAY);
  assert.equal(kept.workStart, '08:15');
  assert.equal(kept.workEnd, '17:45');
});

check('非法新字段被规范化（restMode/custom/alternating/lunch/notifyBefore）', () => {
  const s = sanitizeSettings(
    {
      workStart: '09:00',
      workEnd: '18:00',
      restMode: 'nope',
      customRestDays: [9, 'x'],
      alternating: { anchorDate: '2026-02-31', anchorIsDouble: 'yes' },
      lunch: { enabled: true, start: '13:00', end: '12:00' },
      notifyAtEnd: 'true',
      notifyBeforeMinutes: 121,
    },
    MONDAY,
  );
  assert.equal(s.restMode, 'double');
  assert.deepEqual(s.customRestDays, [0, 6]);
  assert.deepEqual(s.alternating, { anchorDate: WEEK1_MONDAY, anchorIsDouble: true });
  // 启用的午休若时间倒序，视为关闭，避免出现荒谬的午休状态
  assert.deepEqual(s.lunch, { enabled: false, start: '13:00', end: '12:00' });
  assert.equal(s.notifyAtEnd, true); // 非布尔 -> 默认
  assert.equal(s.notifyBeforeMinutes, 0);
});

check('validateTimes 拒绝相同/倒序/非法时间', () => {
  assert.equal(validateTimes('09:00', '18:00').ok, true);
  assert.equal(validateTimes('09:00', '09:00').ok, false);
  assert.equal(validateTimes('18:00', '09:00').ok, false);
  assert.equal(validateTimes('', '18:00').ok, false);
  assert.equal(validateTimes('09:00', '十八点').ok, false);
});

check('validateSettings 接受完整合法设置并返回规范化结果', () => {
  const result = validateSettings(validPayload(), MONDAY);
  assert.equal(result.ok, true);
  assert.equal(result.settings.workStart, '09:00');
  assert.equal(result.settings.restMode, 'double');
});

check('validateSettings 拒绝非法午休（倒序/相同/非法格式）', () => {
  for (const lunch of [
    { enabled: true, start: '13:00', end: '12:00' },
    { enabled: true, start: '12:00', end: '12:00' },
    { enabled: true, start: '25:00', end: '13:00' },
    { enabled: true, start: '12:00', end: '下午' },
    { enabled: 'yes', start: '12:00', end: '13:00' },
    null,
  ]) {
    const result = validateSettings(validPayload({ lunch }), MONDAY);
    assert.equal(result.ok, false, JSON.stringify(lunch));
    assert.match(result.error, /午休/);
  }
  // 关闭午休时，时间输入框被禁用，允许提交
  assert.equal(
    validateSettings(
      validPayload({ lunch: { enabled: false, start: '13:00', end: '12:00' } }),
      MONDAY,
    ).ok,
    true,
  );
});

check('validateSettings 拒绝非法 notifyBeforeMinutes（-1/121/小数/字符串/缺失）', () => {
  for (const value of [-1, 121, 1.5, '10', null, undefined, NaN]) {
    const result = validateSettings(
      validPayload({ notifyBeforeMinutes: value }),
      MONDAY,
    );
    assert.equal(result.ok, false, String(value));
    assert.match(result.error, /0–120/);
  }
  for (const value of [0, 10, 120]) {
    assert.equal(
      validateSettings(validPayload({ notifyBeforeMinutes: value }), MONDAY).ok,
      true,
      String(value),
    );
  }
});

check('validateSettings 拒绝非法休息日模式 / 自定义休息日 / 大小休锚点', () => {
  for (const payload of [
    validPayload({ restMode: 'weekend' }),
    validPayload({ restMode: 'custom', customRestDays: [7] }),
    validPayload({ restMode: 'custom', customRestDays: ['1'] }),
    validPayload({ restMode: 'custom', customRestDays: '1,2' }),
    validPayload({
      restMode: 'alternating',
      alternating: { anchorDate: '2026-02-31', anchorIsDouble: true },
    }),
    validPayload({
      restMode: 'alternating',
      alternating: { anchorDate: WEEK1_MONDAY, anchorIsDouble: 'yes' },
    }),
    validPayload({ notifyAtEnd: 'yes' }),
  ]) {
    const result = validateSettings(payload, MONDAY);
    assert.equal(result.ok, false, JSON.stringify(payload));
  }
});

check('formatDuration 向上取整，跨小时/跨天正确', () => {
  assert.equal(formatDuration(0), '00:00:00');
  assert.equal(formatDuration(999), '00:00:01');
  assert.equal(formatDuration(1000), '00:00:01');
  assert.equal(formatDuration(1001), '00:00:02');
  assert.equal(formatDuration(9 * 3600 * 1000), '09:00:00');
  assert.equal(formatDuration(7 * 3600 * 1000 + 31 * 60 * 1000 + 42 * 1000), '07:31:42');
  assert.equal(formatDuration(-500), '00:00:00');
});

check('formatRestDays 按周一…周日排序', () => {
  assert.equal(formatRestDays([0, 6]), '周六、周日');
  assert.equal(formatRestDays([0, 6, 1]), '周一、周六、周日');
  assert.equal(formatRestDays([]), '');
});

check('双休：周六周日休息，周五/周一正常工作', () => {
  const s = makeSettings();
  assert.equal(computeStatus(s, local(2026, 11, 13, 10)).state, 'countdown'); // 周五
  for (const day of [14, 15]) {
    const status = computeStatus(s, local(2026, 11, day, 10));
    assert.equal(status.state, 'rest');
    assert.equal(status.title, '周末愉快');
    assert.equal(status.isWorkday, false);
    assert.equal(status.isWeekendRest, true);
    assert.equal(status.remainingMs, 0);
    assert.equal(status.workRemainingMs, 0);
  }
  assert.equal(computeStatus(s, local(2026, 11, 16, 10)).state, 'countdown');
});

check('单休：周六是工作日，仅周日休息', () => {
  const s = makeSettings({ restMode: 'single' });
  const saturday = computeStatus(s, local(2026, 11, 14, 10, 0, 0));
  assert.equal(saturday.isWorkday, true);
  assert.equal(saturday.state, 'countdown');
  assert.equal(saturday.title, '距下班 08:00:00');
  assert.equal(saturday.isWeekendRest, false);

  const sunday = computeStatus(s, local(2026, 11, 15, 10, 0, 0));
  assert.equal(sunday.state, 'rest');
  assert.equal(sunday.title, '周末愉快');
  assert.equal(sunday.isWeekendRest, true);
});

check('大小休：以锚点周为双休周，按周交替（两种锚点都覆盖）', () => {
  const doubleFirst = makeSettings({
    restMode: 'alternating',
    alternating: { anchorDate: WEEK1_MONDAY, anchorIsDouble: true },
  });
  // 第 1 周（双休周）
  assert.equal(computeStatus(doubleFirst, local(2026, 11, 9)).alternatingLabel, '双休周');
  assert.equal(computeStatus(doubleFirst, local(2026, 11, 14)).state, 'rest'); // 周六
  assert.equal(computeStatus(doubleFirst, local(2026, 11, 15)).state, 'rest');
  // 第 2 周（单休周）
  const week2 = computeStatus(doubleFirst, local(2026, 11, 16));
  assert.equal(week2.alternatingLabel, '单休周');
  assert.equal(week2.alternatingWeek, 'single');
  assert.equal(computeStatus(doubleFirst, local(2026, 11, 21)).state, 'countdown'); // 周六上班
  assert.equal(computeStatus(doubleFirst, local(2026, 11, 22)).state, 'rest');
  // 第 3 周（又回到双休周）
  assert.equal(computeStatus(doubleFirst, local(2026, 11, 23)).alternatingLabel, '双休周');
  assert.equal(computeStatus(doubleFirst, local(2026, 11, 28)).state, 'rest');

  // 反向锚点：第 1 周为单休周
  const singleFirst = makeSettings({
    restMode: 'alternating',
    alternating: { anchorDate: WEEK1_MONDAY, anchorIsDouble: false },
  });
  assert.equal(computeStatus(singleFirst, local(2026, 11, 14)).state, 'countdown');
  assert.equal(computeStatus(singleFirst, local(2026, 11, 15)).state, 'rest');
  assert.equal(computeStatus(singleFirst, local(2026, 11, 21)).state, 'rest');
  assert.equal(computeStatus(singleFirst, local(2026, 11, 22)).state, 'rest');
});

check('大小休：锚点落在周中时仍按所在周（周一起点）计算', () => {
  const s = makeSettings({
    restMode: 'alternating',
    alternating: { anchorDate: '2026-11-11', anchorIsDouble: true }, // 周三
  });
  assert.equal(alternatingWeekIsDouble(s.alternating, local(2026, 11, 9)), true);
  assert.equal(alternatingWeekIsDouble(s.alternating, local(2026, 11, 14)), true);
  assert.equal(alternatingWeekIsDouble(s.alternating, local(2026, 11, 16)), false);
});

check('自定义休息日：恰好勾选的日子休息，其它日子（含周末）上班', () => {
  const s = makeSettings({ restMode: 'custom', customRestDays: [1, 3] }); // 周一/周三
  const monday = computeStatus(s, local(2026, 11, 9, 10));
  assert.equal(monday.state, 'rest');
  assert.equal(monday.title, '今天休息');
  assert.equal(monday.isWeekendRest, false);
  assert.equal(monday.isWorkday, false);

  assert.equal(computeStatus(s, local(2026, 11, 10, 10)).state, 'countdown'); // 周二
  assert.equal(computeStatus(s, local(2026, 11, 11, 10)).state, 'rest'); // 周三
  const saturday = computeStatus(s, local(2026, 11, 14, 10)); // 周六未勾选 -> 工作日
  assert.equal(saturday.state, 'countdown');
  assert.equal(saturday.isWorkday, true);

  // 勾选周末时仍然显示「周末愉快」
  const weekend = makeSettings({ restMode: 'custom', customRestDays: [0, 6] });
  const sat = computeStatus(weekend, local(2026, 11, 14, 10));
  assert.equal(sat.state, 'rest');
  assert.equal(sat.title, '周末愉快');
  assert.equal(sat.isWeekendRest, true);

  // 一天都不勾选 = 每天都是工作日
  const none = makeSettings({ restMode: 'custom', customRestDays: [] });
  assert.equal(computeStatus(none, local(2026, 11, 14, 10)).state, 'countdown');
  assert.equal(computeStatus(none, local(2026, 11, 15, 10)).state, 'countdown');
});

check('restDaysForWeek / describeRest 输出正确的模式说明', () => {
  assert.deepEqual(restDaysForWeek(makeSettings(), MONDAY), [0, 6]);
  assert.deepEqual(restDaysForWeek(makeSettings({ restMode: 'single' }), MONDAY), [0]);
  assert.deepEqual(
    restDaysForWeek(
      makeSettings({
        restMode: 'alternating',
        alternating: { anchorDate: WEEK1_MONDAY, anchorIsDouble: true },
      }),
      MONDAY,
    ),
    [0, 6],
  );
  assert.deepEqual(
    restDaysForWeek(
      makeSettings({
        restMode: 'alternating',
        alternating: { anchorDate: WEEK1_MONDAY, anchorIsDouble: true },
      }),
      local(2026, 11, 16),
    ),
    [0],
  );
  assert.deepEqual(
    restDaysForWeek(makeSettings({ restMode: 'custom', customRestDays: [3, 1] }), MONDAY),
    [1, 3],
  );

  assert.equal(describeRest(makeSettings(), MONDAY), '双休 · 周六、周日休息');
  assert.equal(describeRest(makeSettings({ restMode: 'single' }), MONDAY), '单休 · 周日休息');
  assert.equal(
    describeRest(
      makeSettings({
        restMode: 'alternating',
        alternating: { anchorDate: WEEK1_MONDAY, anchorIsDouble: true },
      }),
      MONDAY,
    ),
    '本周：双休周',
  );
  assert.equal(
    describeRest(
      makeSettings({
        restMode: 'alternating',
        alternating: { anchorDate: WEEK1_MONDAY, anchorIsDouble: true },
      }),
      local(2026, 11, 16),
    ),
    '本周：单休周',
  );
  assert.equal(
    describeRest(makeSettings({ restMode: 'custom', customRestDays: [1, 3] }), MONDAY),
    '自定义休息日 · 周一、周三',
  );
  assert.equal(
    describeRest(makeSettings({ restMode: 'custom', customRestDays: [] }), MONDAY),
    '自定义休息日 · 无',
  );
});

check('工作日倒计时：周一上午、下班前一秒、整点、深夜、日切', () => {
  const s = makeSettings();
  const monday = computeStatus(s, local(2026, 11, 9, 10, 28, 18));
  assert.equal(monday.state, 'countdown');
  assert.equal(monday.remainingMs, (7 * 3600 + 31 * 60 + 42) * 1000);
  assert.equal(monday.title, '距下班 07:31:42');
  assert.match(monday.header, /距下班 07:31:42/);

  assert.equal(
    computeStatus(s, local(2026, 11, 9, 17, 59, 59, 500)).title,
    '距下班 00:00:01',
  );
  assert.equal(computeStatus(s, local(2026, 11, 9, 18, 0, 0, 0)).state, 'done');
  assert.equal(computeStatus(s, local(2026, 11, 9, 23, 59, 59)).title, '已下班');
  assert.equal(
    computeStatus(s, local(2026, 11, 10, 0, 0, 0, 0)).title,
    '距下班 18:00:00',
  );
});

check('午休：开始前 / 午休中 / 结束边界 / 结束后', () => {
  const s = makeSettings(); // 09:00–18:00，午休 12:00–13:00
  const before = computeStatus(s, local(2026, 11, 9, 11, 59, 59));
  assert.equal(before.state, 'countdown');
  assert.equal(before.title, '距下班 06:00:01');
  assert.equal(before.lunch.active, false);
  assert.equal(before.lunch.startRemainingMs, 1000);
  assert.equal(before.lunch.remainingMs, null);

  const start = computeStatus(s, local(2026, 11, 9, 12, 0, 0));
  assert.equal(start.state, 'lunch');
  assert.equal(start.title, '午休中 01:00:00');
  assert.equal(start.header, '午休中 · 距下午上班 01:00:00');
  assert.equal(start.remainingMs, 3600000);
  assert.equal(start.lunch.active, true);
  assert.equal(start.lunch.startRemainingMs, null);
  // 午休不改变绝对下班时间
  assert.equal(start.workRemainingMs, 6 * 3600000);

  const middle = computeStatus(s, local(2026, 11, 9, 12, 30, 0));
  assert.equal(middle.title, '午休中 00:30:00');
  assert.equal(middle.remainingMs, 1800000);

  const last = computeStatus(s, local(2026, 11, 9, 12, 59, 59, 500));
  assert.equal(last.state, 'lunch');
  assert.equal(last.title, '午休中 00:00:01');

  const end = computeStatus(s, local(2026, 11, 9, 13, 0, 0, 0));
  assert.equal(end.state, 'countdown');
  assert.equal(end.title, '距下班 05:00:00');
  assert.equal(end.lunch.active, false);
  assert.equal(end.remainingMs, 5 * 3600000);
});

check('午休：关闭 / 非法配置时不影响倒计时', () => {
  const disabled = makeSettings({
    lunch: { enabled: false, start: '12:00', end: '13:00' },
  });
  const noon = computeStatus(disabled, local(2026, 11, 9, 12, 30, 0));
  assert.equal(noon.state, 'countdown');
  assert.equal(noon.title, '距下班 05:30:00');
  assert.equal(noon.lunch.enabled, false);

  const invalid = makeSettings({
    lunch: { enabled: true, start: '13:00', end: '12:00' },
  });
  assert.equal(invalid.lunch.enabled, false);
  assert.equal(
    computeStatus(invalid, local(2026, 11, 9, 12, 30, 0)).state,
    'countdown',
  );
});

check('午休窗口跨过下班时间时，下班状态优先', () => {
  const s = makeSettings({
    workStart: '09:00',
    workEnd: '12:30',
    lunch: { enabled: true, start: '12:00', end: '13:00' },
  });
  assert.equal(computeStatus(s, local(2026, 11, 9, 12, 15, 0)).state, 'lunch');
  const done = computeStatus(s, local(2026, 11, 9, 12, 30, 0));
  assert.equal(done.state, 'done');
  assert.equal(done.title, '已下班');
});

check('休息日不会倒计时，也不会产生通知事件', () => {
  const s = makeSettings();
  const rest = computeStatus(s, local(2026, 11, 14, 10));
  assert.equal(rest.state, 'rest');
  assert.equal(rest.remainingMs, 0);
  assert.equal(rest.workRemainingMs, 0);
  assert.equal(rest.isWorkday, false);
  assert.deepEqual(notificationEvents(s, null, rest), { end: false, before: false });

  const friday = computeStatus(s, local(2026, 11, 13, 17, 59, 59));
  const saturday = computeStatus(s, local(2026, 11, 14, 0, 0, 1));
  assert.deepEqual(notificationEvents(s, friday, saturday), {
    end: false,
    before: false,
  });

  const sundayDone = computeStatus(s, local(2026, 11, 15, 20, 0, 0));
  assert.equal(sundayDone.state, 'rest');
  assert.deepEqual(notificationEvents(s, rest, sundayDone), {
    end: false,
    before: false,
  });
});

check('提前提醒阈值：仅在运行期间跨越阈值时触发', () => {
  const s = makeSettings({ notifyBeforeMinutes: 10 });
  assert.equal(shouldNotifyBefore(s, 600001, 599999), true);
  assert.equal(shouldNotifyBefore(s, 900000, 599999), true);
  assert.equal(shouldNotifyBefore(s, 600000, 599999), false); // 上一 tick 已等于阈值
  assert.equal(shouldNotifyBefore(s, 599999, 599000), false); // 启动时已在阈值内
  assert.equal(shouldNotifyBefore(s, 600001, 0), false); // 已下班，走下班通知
  assert.equal(shouldNotifyBefore(s, null, 599999), false); // 刚启动
  assert.equal(shouldNotifyBefore(s, 600001, 599999), true);
  assert.equal(
    shouldNotifyBefore(makeSettings({ notifyBeforeMinutes: 0 }), 600001, 599999),
    false,
  );
  assert.equal(
    shouldNotifyBefore(makeSettings({ notifyBeforeMinutes: 120 }), 7200001, 7199999),
    true,
  );
});

check('notificationEvents 组合下班/提前/休息/关闭通知', () => {
  const s = makeSettings({ notifyBeforeMinutes: 10, notifyAtEnd: true });
  const prev = { isWorkday: true, state: 'countdown', workRemainingMs: 600001 };
  const curr = { isWorkday: true, state: 'countdown', workRemainingMs: 599999 };
  assert.deepEqual(notificationEvents(s, prev, curr), { end: false, before: true });

  const beforeEnd = { isWorkday: true, state: 'countdown', workRemainingMs: 500 };
  const done = { isWorkday: true, state: 'done', workRemainingMs: 0 };
  assert.deepEqual(notificationEvents(s, beforeEnd, done), { end: true, before: false });

  assert.deepEqual(
    notificationEvents(makeSettings({ notifyAtEnd: false }), beforeEnd, done),
    { end: false, before: false },
  );
  // 提前提醒独立于「下班时通知」
  assert.deepEqual(
    notificationEvents(
      makeSettings({ notifyAtEnd: false, notifyBeforeMinutes: 10 }),
      prev,
      curr,
    ),
    { end: false, before: true },
  );
  // 休息日 / 启动首帧
  assert.deepEqual(
    notificationEvents(s, { ...prev, isWorkday: false }, curr),
    { end: false, before: false },
  );
  assert.deepEqual(notificationEvents(s, null, curr), { end: false, before: false });
  // 午休状态仍然继续累计「距下班」剩余时间
  assert.deepEqual(
    notificationEvents(s, { isWorkday: true, state: 'lunch', workRemainingMs: 600001 }, {
      isWorkday: true,
      state: 'lunch',
      workRemainingMs: 599999,
    }),
    { end: false, before: true },
  );
});

check('dayKey 使用本地日期', () => {
  assert.equal(dayKey(local(2026, 11, 9, 23, 59, 59)), '2026-11-09');
  assert.equal(dayKey(local(2026, 11, 10, 0, 0, 1)), '2026-11-10');
});

check('weeklyPlan 规范化：非周一键归一到周一 / 非法项丢弃 / 键排序', () => {
  const plan = sanitizeWeeklyPlan({
    '2026-11-11': 'single', // 周三 -> 所在周一 11-09
    '2026-11-02': 'double',
    '2026-02-31': 'single',
    '2026-11-16': 'triple',
    'not-a-date': 'double',
  });
  assert.deepEqual(plan, { '2026-11-02': 'double', '2026-11-09': 'single' });
  assert.deepEqual(Object.keys(plan), ['2026-11-02', '2026-11-09']);
  assert.deepEqual(sanitizeWeeklyPlan(null), {});
  assert.deepEqual(sanitizeWeeklyPlan([]), {});
  assert.deepEqual(sanitizeWeeklyPlan('x'), {});

  const s = sanitizeSettings({ weeklyPlan: { '2026-11-11': 'single' } }, MONDAY);
  assert.deepEqual(s.weeklyPlan, { '2026-11-09': 'single' });
  assert.deepEqual(sanitizeSettings({}, MONDAY).weeklyPlan, {});
});

check('overtime 默认值与规范化：enabled=true，start 缺失回退 workEnd', () => {
  assert.deepEqual(sanitizeSettings({}, MONDAY).overtime, {
    enabled: true,
    start: '18:00',
  });
  assert.deepEqual(sanitizeSettings({ workEnd: '19:30' }, MONDAY).overtime, {
    enabled: true,
    start: '19:30',
  });
  assert.deepEqual(
    sanitizeSettings(
      { workEnd: '19:00', overtime: { enabled: false, start: '20:15' } },
      MONDAY,
    ).overtime,
    { enabled: false, start: '20:15' },
  );
  // 非法 start/ enabled 回退：start 用 workEnd，enabled 用 true
  assert.deepEqual(
    sanitizeSettings(
      { workEnd: '19:00', overtime: { enabled: 'no', start: '25:00' } },
      MONDAY,
    ).overtime,
    { enabled: true, start: '19:00' },
  );
  assert.deepEqual(sanitizeOvertime(null, '18:30'), {
    enabled: true,
    start: '18:30',
  });
});

check('validateSettings 校验 weeklyPlan / overtime，缺省时向后兼容', () => {
  assert.equal(
    validateSettings(validPayload({ weeklyPlan: { [WEEK1_MONDAY]: 'single' } }), MONDAY).ok,
    true,
  );
  assert.equal(
    validateSettings(validPayload({ weeklyPlan: { [WEEK1_MONDAY]: 'double' } }), MONDAY).ok,
    true,
  );
  for (const weeklyPlan of [
    { '2026-02-31': 'double' },
    { [WEEK1_MONDAY]: 'triple' },
    { [WEEK1_MONDAY]: true },
    [],
    'x',
  ]) {
    assert.equal(
      validateSettings(validPayload({ weeklyPlan }), MONDAY).ok,
      false,
      JSON.stringify(weeklyPlan),
    );
  }
  assert.equal(
    validateSettings(validPayload({ overtime: { enabled: true, start: '20:00' } }), MONDAY).ok,
    true,
  );
  for (const overtime of [
    { enabled: 'yes', start: '20:00' },
    { enabled: true, start: '25:00' },
    { enabled: true },
    [],
    null,
  ]) {
    const result = validateSettings(validPayload({ overtime }), MONDAY);
    if (overtime === null) {
      assert.equal(result.ok, true, 'null 视为缺省');
    } else {
      assert.equal(result.ok, false, JSON.stringify(overtime));
      assert.match(result.error, /加班/);
    }
  }
  // 旧调用方不传新字段仍然合法
  assert.equal(validateSettings(validPayload(), MONDAY).ok, true);
});

check('weeksOfMonth 枚举 2026 年 11 月：6 周（含 10 月/12 月跨月周）', () => {
  const weeks = weeksOfMonth(2026, 10, MONDAY);
  assert.equal(weeks.length, 6);
  assert.equal(weeks[0].index, 1);
  assert.equal(weeks[0].label, '第1周 · 10/26–11/01');
  assert.equal(weeks[0].monday, '2026-10-26');
  assert.equal(weeks[0].startKey, '2026-10-26');
  assert.equal(weeks[0].endKey, '2026-11-01');
  assert.equal(weeks[0].startMonth, 9);
  assert.equal(weeks[0].startDay, 26);
  assert.equal(weeks[0].endMonth, 10);
  assert.equal(weeks[0].endDay, 1);
  assert.equal(weeks[0].isCurrent, false);

  assert.equal(weeks[1].label, '第2周 · 11/02–11/08');
  assert.equal(weeks[2].label, '第3周 · 11/09–11/15');
  assert.equal(weeks[2].monday, WEEK1_MONDAY);
  assert.equal(weeks[2].isCurrent, true);
  assert.equal(weeks[3].label, '第4周 · 11/16–11/22');
  assert.equal(weeks[4].label, '第5周 · 11/23–11/29');
  assert.equal(weeks[5].label, '第6周 · 11/30–12/06');
  assert.equal(weeks[5].endKey, '2026-12-06');
  assert.equal(weeks[5].endMonth, 11);
  assert.equal(weeks[5].endDay, 6);
  assert.equal(weeks.filter((week) => week.isCurrent).length, 1);

  // 2026 年 12 月（12-01 是周二）：第 1 周从 11-30 开始
  const december = weeksOfMonth(2026, 11, local(2026, 12, 1));
  assert.equal(december.length, 5);
  assert.equal(december[0].label, '第1周 · 11/30–12/06');
  assert.equal(december[0].isCurrent, true);

  // 2026 年 2 月：5 行，第 1 行从 01-26 开始
  const february = weeksOfMonth(2026, 1, local(2026, 2, 15));
  assert.equal(february.length, 5);
  assert.equal(february[0].label, '第1周 · 01/26–02/01');

  // 2027 年 2 月：2/1 是周一，恰好 4 行
  const four = weeksOfMonth(2027, 1, local(2027, 2, 10));
  assert.equal(four.length, 4);
  assert.equal(four[0].label, '第1周 · 02/01–02/07');
  assert.equal(four[3].label, '第4周 · 02/22–02/28');
});

check('resolveWeekPlan：双休 / 单休 / 未配置回退双休（周一起点）', () => {
  const s = makeSettings({
    weeklyPlan: {
      [WEEK1_MONDAY]: 'single',
      [WEEK2_MONDAY]: 'double',
    },
  });
  assert.equal(resolveWeekPlan(s, local(2026, 11, 9)), 'single');
  assert.equal(resolveWeekPlan(s, local(2026, 11, 15)), 'single'); // 周日仍属同一周
  assert.equal(resolveWeekPlan(s, local(2026, 11, 16)), 'double');
  assert.equal(resolveWeekPlan(s, local(2026, 11, 23)), 'double'); // 未配置 -> 双休
  assert.equal(resolveWeekPlan(s, local(2026, 11, 29)), 'double');
  assert.equal(resolveWeekPlan({}, MONDAY), 'double');
  assert.equal(resolveWeekPlan(null, MONDAY), 'double');
  // 非周一键在 sanitize 时归一到周一
  const normalized = makeSettings({ weeklyPlan: { '2026-11-11': 'single' } });
  assert.equal(resolveWeekPlan(normalized, local(2026, 11, 9)), 'single');
});

check('按月四周：双休周 / 单休周 / 未配置周（回退双休）的休息日判定', () => {
  const s = makeSettings({
    restMode: 'monthly',
    weeklyPlan: {
      [WEEK1_MONDAY]: 'double',
      [WEEK2_MONDAY]: 'single',
      // 第 3 周（11-23）故意不配置 -> 双休
    },
  });

  // 第 1 周双休：周六 + 周日都休息
  for (const day of [14, 15]) {
    const status = computeStatus(s, local(2026, 11, day, 10));
    assert.equal(status.state, 'rest');
    assert.equal(status.title, '周末愉快');
    assert.equal(status.isWorkday, false);
    assert.equal(status.isWeekendRest, true);
    assert.equal(status.remainingMs, 0);
    assert.equal(status.workRemainingMs, 0);
    assert.equal(status.monthlyWeekPlan, 'double');
  }
  assert.deepEqual(restDaysForWeek(s, local(2026, 11, 14)), [0, 6]);

  // 第 2 周单休：周六是工作日，仅周日休息
  const saturday = computeStatus(s, local(2026, 11, 21, 10));
  assert.equal(saturday.isWorkday, true);
  assert.equal(saturday.state, 'countdown');
  assert.equal(saturday.title, '距下班 08:00:00');
  assert.equal(saturday.isWeekendRest, false);
  assert.equal(saturday.monthlyWeekPlan, 'single');
  const sunday = computeStatus(s, local(2026, 11, 22, 10));
  assert.equal(sunday.state, 'rest');
  assert.equal(sunday.title, '周末愉快');
  assert.deepEqual(restDaysForWeek(s, local(2026, 11, 21)), [0]);

  // 第 3 周未配置：按双休
  assert.deepEqual(restDaysForWeek(s, local(2026, 11, 28)), [0, 6]);
  assert.equal(computeStatus(s, local(2026, 11, 28, 10)).state, 'rest');
  assert.equal(computeStatus(s, local(2026, 11, 29, 10)).state, 'rest');

  // 菜单说明 / 当前周序号
  assert.equal(describeRest(s, local(2026, 11, 9)), '本月：第3周 双休');
  assert.equal(describeRest(s, local(2026, 11, 16)), '本月：第4周 单休');
  assert.equal(monthlyWeekSummary(s, local(2026, 11, 9)), '本月：第3周 双休');
  assert.equal(computeStatus(s, local(2026, 11, 9)).monthlyWeekIndex, 3);
  assert.equal(computeStatus(s, local(2026, 11, 16)).monthlyWeekIndex, 4);

  // 工作日休息标签：自定义模式（非周末休息日）仍显示「今天休息」
  const custom = makeSettings({ restMode: 'custom', customRestDays: [1] });
  const monday = computeStatus(custom, local(2026, 11, 9, 10));
  assert.equal(monday.state, 'rest');
  assert.equal(monday.title, '今天休息');
  assert.equal(monday.isWeekendRest, false);
});

check('其它休息模式回归：double / single / alternating / custom 不受月排班影响', () => {
  assert.deepEqual(restDaysForWeek(makeSettings(), MONDAY), [0, 6]);
  assert.deepEqual(restDaysForWeek(makeSettings({ restMode: 'single' }), MONDAY), [0]);
  assert.deepEqual(
    restDaysForWeek(
      makeSettings({
        restMode: 'alternating',
        alternating: { anchorDate: WEEK1_MONDAY, anchorIsDouble: true },
      }),
      local(2026, 11, 16),
    ),
    [0],
  );
  assert.deepEqual(
    restDaysForWeek(makeSettings({ restMode: 'custom', customRestDays: [1, 3] }), MONDAY),
    [1, 3],
  );
  // 带 weeklyPlan 但模式不是 monthly 时，weeklyPlan 不生效
  const withPlan = makeSettings({
    weeklyPlan: { [WEEK1_MONDAY]: 'single' },
    restMode: 'double',
  });
  assert.deepEqual(restDaysForWeek(withPlan, MONDAY), [0, 6]);
  assert.equal(computeStatus(withPlan, local(2026, 11, 14, 10)).state, 'rest');
});

check('overtime：起算前 idle、起算后 counting、精确字符串与 startAt', () => {
  const s = makeSettings({
    workEnd: '19:00',
    overtime: { enabled: true, start: '19:00' },
  });
  const before = computeOvertime(s, local(2026, 11, 9, 18, 59, 59));
  assert.equal(before.enabled, true);
  assert.equal(before.state, 'idle');
  assert.equal(before.title, '暂无加班');
  assert.equal(before.header, '暂无加班（19:00 起算）');
  assert.equal(before.elapsedMs, 0);
  assert.equal(before.startAt.getHours(), 19);
  assert.equal(before.startAt.getMinutes(), 0);
  assert.equal(before.dayKey, '2026-11-09');

  const atStart = computeOvertime(s, local(2026, 11, 9, 19, 0, 0));
  assert.equal(atStart.state, 'counting');
  assert.equal(atStart.title, '加班时长:00:00:00');
  assert.equal(atStart.elapsedMs, 0);

  const later = computeOvertime(s, local(2026, 11, 9, 20, 23, 45));
  assert.equal(later.state, 'counting');
  assert.equal(later.title, '加班时长:01:23:45');
  assert.equal(later.header, '加班时长 01:23:45（19:00 起算）');
  assert.equal(later.elapsedMs, (1 * 3600 + 23 * 60 + 45) * 1000);

  const earlierStart = computeOvertime(
    makeSettings({ workEnd: '19:00', overtime: { enabled: true, start: '17:05' } }),
    local(2026, 11, 9, 18, 0, 0),
  );
  assert.equal(earlierStart.title, '加班时长:00:55:00');
  assert.equal(earlierStart.header, '加班时长 00:55:00（17:05 起算）');
});

check('overtime：休息日 idle、关闭 idle、每月/大小休单休周六照常计时', () => {
  const s = makeSettings({
    workEnd: '19:00',
    overtime: { enabled: true, start: '19:00' },
  });
  // 双休周六/周日
  for (const day of [14, 15]) {
    const idle = computeOvertime(s, local(2026, 11, day, 21, 0, 0));
    assert.equal(idle.state, 'idle');
    assert.equal(idle.title, '暂无加班');
    assert.equal(idle.elapsedMs, 0);
  }
  // 关闭
  const disabled = makeSettings({
    workEnd: '19:00',
    overtime: { enabled: false, start: '00:00' },
  });
  const off = computeOvertime(disabled, local(2026, 11, 9, 22, 0, 0));
  assert.equal(off.enabled, false);
  assert.equal(off.state, 'idle');
  assert.equal(off.title, '暂无加班');
  assert.equal(off.elapsedMs, 0);

  // 按月四周：单休周的周六是工作日 -> 计时；周日休息 -> idle
  const monthly = makeSettings({
    restMode: 'monthly',
    weeklyPlan: { [WEEK2_MONDAY]: 'single' },
    workEnd: '19:00',
    overtime: { enabled: true, start: '19:00' },
  });
  assert.equal(computeOvertime(monthly, local(2026, 11, 21, 20, 0, 0)).state, 'counting');
  assert.equal(computeOvertime(monthly, local(2026, 11, 22, 20, 0, 0)).state, 'idle');

  // 大小休：单休周的周六照常计时
  const alternating = makeSettings({
    restMode: 'alternating',
    alternating: { anchorDate: WEEK1_MONDAY, anchorIsDouble: false },
    workEnd: '19:00',
    overtime: { enabled: true, start: '19:00' },
  });
  assert.equal(
    computeOvertime(alternating, local(2026, 11, 14, 20, 0, 0)).state,
    'counting',
  );
});

check('overtime：跨午夜重置、按当天起算、长时长 HH 超过两位', () => {
  const s = makeSettings({
    workEnd: '19:00',
    overtime: { enabled: true, start: '19:00' },
  });
  const late = computeOvertime(s, local(2026, 11, 9, 23, 59, 59));
  assert.equal(late.title, '加班时长:04:59:59');
  assert.equal(late.dayKey, '2026-11-09');

  const nextDay = computeOvertime(s, local(2026, 11, 10, 0, 0, 1));
  assert.equal(nextDay.state, 'idle');
  assert.equal(nextDay.title, '暂无加班');
  assert.equal(nextDay.elapsedMs, 0);
  assert.equal(nextDay.dayKey, '2026-11-10');
  assert.equal(nextDay.startAt.getDate(), 10);

  const midnightStart = makeSettings({
    workEnd: '19:00',
    overtime: { enabled: true, start: '00:00' },
  });
  const reset = computeOvertime(midnightStart, local(2026, 11, 10, 0, 0, 1));
  assert.equal(reset.state, 'counting');
  assert.equal(reset.title, '加班时长:00:00:01');
  assert.equal(reset.elapsedMs, 1000);

  // formatDuration 的 HH 可超过两位（computeOvertime 单日最长 24h）
  assert.equal(formatDuration(100 * 3600 * 1000), '100:00:00');
});

check('overtime 不影响倒计时 / 午休 / 通知', () => {
  const base = makeSettings({ workEnd: '19:00', notifyBeforeMinutes: 10 });
  const withOvertime = makeSettings({
    workEnd: '19:00',
    notifyBeforeMinutes: 10,
    overtime: { enabled: true, start: '00:00' },
  });
  for (const at of [
    local(2026, 11, 9, 10, 0, 0),
    local(2026, 11, 9, 12, 30, 0),
    local(2026, 11, 9, 19, 30, 0),
  ]) {
    const a = computeStatus(base, at);
    const b = computeStatus(withOvertime, at);
    assert.equal(b.state, a.state);
    assert.equal(b.title, a.title);
    assert.equal(b.header, a.header);
    assert.equal(b.workRemainingMs, a.workRemainingMs);
    assert.equal(b.remainingMs, a.remainingMs);
    assert.deepEqual(b.lunch, a.lunch);
  }
  const prev = { isWorkday: true, state: 'countdown', workRemainingMs: 600001 };
  const curr = { isWorkday: true, state: 'countdown', workRemainingMs: 599999 };
  assert.deepEqual(
    notificationEvents(withOvertime, prev, curr),
    notificationEvents(base, prev, curr),
  );
  assert.deepEqual(notificationEvents(withOvertime, prev, curr), {
    end: false,
    before: true,
  });
});

check('月排班校验：monthly 模式 + 空 weeklyPlan 合法（全部按双休）', () => {
  const payload = validPayload({ restMode: 'monthly', weeklyPlan: {} });
  const result = validateSettings(payload, MONDAY);
  assert.equal(result.ok, true);
  assert.equal(result.settings.restMode, 'monthly');
  assert.deepEqual(result.settings.weeklyPlan, {});
  assert.equal(computeStatus(result.settings, local(2026, 11, 14, 10)).state, 'rest');
});

check('trayAccentState：工作日白天 / 午休边界 / 午休关闭', () => {
  const s = makeSettings({
    workEnd: '19:00',
    lunch: { enabled: true, start: '12:00', end: '13:00' },
    overtime: { enabled: true, start: '19:00' },
  });
  // 午休前
  assert.equal(trayAccentState(s, local(2026, 11, 9, 9, 0, 0)), 'work');
  assert.equal(trayAccentState(s, local(2026, 11, 9, 11, 59, 59)), 'work');
  // 午休开始（含）到结束（不含）
  assert.equal(trayAccentState(s, local(2026, 11, 9, 12, 0, 0)), 'lunch');
  assert.equal(trayAccentState(s, local(2026, 11, 9, 12, 30, 0)), 'lunch');
  assert.equal(trayAccentState(s, local(2026, 11, 9, 12, 59, 59)), 'lunch');
  // 午休结束的瞬间恢复 work
  assert.equal(trayAccentState(s, local(2026, 11, 9, 13, 0, 0)), 'work');
  // 关闭午休后同一时刻是 work
  const noLunch = makeSettings({
    workEnd: '19:00',
    lunch: { enabled: false, start: '12:00', end: '13:00' },
    overtime: { enabled: true, start: '19:00' },
  });
  assert.equal(trayAccentState(noLunch, local(2026, 11, 9, 12, 30, 0)), 'work');
});

check('trayAccentState：加班起算 / 下班后未起算 / 加班关闭', () => {
  const s = makeSettings({
    workEnd: '18:00',
    lunch: { enabled: true, start: '12:00', end: '13:00' },
    overtime: { enabled: true, start: '19:00' },
  });
  // 已下班但还没到加班起算 -> 仍是 work（浅橙）
  assert.equal(trayAccentState(s, local(2026, 11, 9, 18, 30, 0)), 'work');
  assert.equal(trayAccentState(s, local(2026, 11, 9, 18, 59, 59)), 'work');
  // 加班起算（含）
  assert.equal(trayAccentState(s, local(2026, 11, 9, 19, 0, 0)), 'overtime');
  assert.equal(trayAccentState(s, local(2026, 11, 9, 23, 59, 59)), 'overtime');
  // 加班关闭 -> work
  const disabled = makeSettings({
    workEnd: '18:00',
    lunch: { enabled: true, start: '12:00', end: '13:00' },
    overtime: { enabled: false, start: '19:00' },
  });
  assert.equal(trayAccentState(disabled, local(2026, 11, 9, 20, 0, 0)), 'work');
});

check('trayAccentState：双休 / 单休 / 自定义休息日均为 rest', () => {
  const base = makeSettings({
    workEnd: '19:00',
    overtime: { enabled: true, start: '19:00' },
  });
  assert.equal(trayAccentState(base, local(2026, 11, 14, 10, 0, 0)), 'rest'); // 周六
  assert.equal(trayAccentState(base, local(2026, 11, 15, 10, 0, 0)), 'rest'); // 周日
  // 休息日即使过了加班起算时间也仍是 rest
  assert.equal(trayAccentState(base, local(2026, 11, 14, 20, 0, 0)), 'rest');

  // 单休：周六是工作日 -> work；周日 rest
  const single = makeSettings({
    restMode: 'single',
    workEnd: '19:00',
    overtime: { enabled: true, start: '19:00' },
  });
  assert.equal(trayAccentState(single, local(2026, 11, 14, 10, 0, 0)), 'work');
  assert.equal(trayAccentState(single, local(2026, 11, 15, 10, 0, 0)), 'rest');

  // 自定义：仅周一休息
  const custom = makeSettings({
    restMode: 'custom',
    customRestDays: [1],
    workEnd: '19:00',
    overtime: { enabled: true, start: '19:00' },
  });
  assert.equal(trayAccentState(custom, local(2026, 11, 9, 10, 0, 0)), 'rest');
  assert.equal(trayAccentState(custom, local(2026, 11, 10, 10, 0, 0)), 'work');
});

check('parseSemver：v 前缀 / 缺省 minor.patch / 预发布 / 非法', () => {
  assert.deepEqual(parseSemver('1.4.0'), {
    major: 1,
    minor: 4,
    patch: 0,
    prerelease: [],
  });
  assert.deepEqual(parseSemver('v1.4'), {
    major: 1,
    minor: 4,
    patch: 0,
    prerelease: [],
  });
  assert.deepEqual(parseSemver('v1.4.0-beta.1').prerelease, ['beta', '1']);
  assert.equal(versionText(parseSemver('v1.4')), '1.4.0');
  assert.equal(versionText(parseSemver('1.4.0-rc.1')), '1.4.0-rc.1');
  assert.equal(parseSemver('1.4.0.1'), null);
  assert.equal(parseSemver('release-notes'), null);
  assert.equal(parseSemver(null), null);
});

check('compareVersions：v1.4.0 = 1.4 = 1.4.0、大小与预发布', () => {
  assert.equal(compareVersions('v1.4.0', '1.4'), 0);
  assert.equal(compareVersions('1.4', '1.4.0'), 0);
  assert.equal(compareVersions('1.4.0', '1.3.9'), 1);
  assert.equal(compareVersions('1.3.9', '1.4.0'), -1);
  assert.equal(compareVersions('1.4.0-beta.1', '1.4.0'), -1);
  assert.equal(compareVersions('1.4.0', '1.4.0-beta.2'), 1);
  assert.equal(compareVersions('1.4.0-alpha', '1.4.0-beta'), -1);
  assert.equal(compareVersions('1.4.0-alpha.1', '1.4.0-alpha'), 1);
  assert.equal(compareVersions('1.4.0-1', '1.4.0-alpha'), -1);
  assert.equal(compareVersions('1.4.0+build.5', '1.4.0'), 0);
  assert.equal(compareVersions('abc', '1.0.0'), -1);
  assert.equal(compareVersions('abc', 'def'), 0);
  assert.equal(isNewerVersion('1.5', '1.4.0'), true);
  assert.equal(isNewerVersion('1.4.0', '1.4.0'), false);
  assert.equal(isNewerVersion('1.3.9', '1.4.0'), false);
});

check('updateResultFromRelease：latest / update / 非法 tag / 非法 JSON', () => {
  const latest = updateResultFromRelease(
    {
      tag_name: 'v1.4.0',
      html_url: 'https://github.com/a/b/releases/tag/v1.4.0',
    },
    '1.4.0',
    'a/b',
  );
  assert.equal(latest.status, 'latest');
  assert.equal(latest.currentVersion, '1.4.0');
  assert.equal(latest.latestVersion, '1.4.0');
  assert.match(latest.message, /已是最新版本 v1\.4\.0/);

  const update = updateResultFromRelease(
    {
      tag_name: 'v1.5.0',
      html_url: 'https://github.com/a/b/releases/tag/v1.5.0',
    },
    '1.4.0',
    'a/b',
  );
  assert.equal(update.status, 'update');
  assert.equal(update.latestVersion, '1.5.0');
  assert.equal(update.url, 'https://github.com/a/b/releases/tag/v1.5.0');
  assert.match(update.message, /发现新版本 v1\.5\.0/);

  // 版本相同但带 v / 缺省 patch
  assert.equal(
    updateResultFromRelease({ tag_name: 'v1.4' }, '1.4.0').status,
    'latest',
  );
  // 预发布版本比正式版旧
  assert.equal(
    updateResultFromRelease({ tag_name: 'v1.4.0-rc.2' }, '1.4.0').status,
    'latest',
  );
  // 非法 tag
  const badTag = updateResultFromRelease({ tag_name: 'release-notes' }, '1.4.0');
  assert.equal(badTag.status, 'error');
  assert.match(badTag.message, /无法解析/);
  // 非法 JSON / null
  for (const release of [null, [], 'x']) {
    const result = updateResultFromRelease(release, '1.4.0');
    assert.equal(result.status, 'error');
    assert.match(result.message, /格式异常/);
  }
  // 没有 html_url 时回退到 releases 页
  assert.equal(
    updateResultFromRelease({ tag_name: 'v1.5.0' }, '1.4.0', 'a/b').url,
    'https://github.com/a/b/releases',
  );
});

check('updateErrorResult：404 / 403 / 网络 / 超时 / 禁用', () => {
  const notFound = updateErrorResult('notfound', 404, '1.4.0');
  assert.equal(notFound.status, 'error');
  assert.equal(notFound.currentVersion, '1.4.0');
  assert.match(notFound.message, /404/);
  assert.match(notFound.message, /还没有发布 Release/);

  assert.match(updateErrorResult('forbidden', 403, '1.4.0').message, /403/);
  assert.match(updateErrorResult('ratelimit', 403, '1.4.0').message, /频率限制/);
  assert.match(updateErrorResult('network', null, '1.4.0').message, /网络连接失败/);
  assert.match(updateErrorResult('timeout', null, '1.4.0').message, /超时/);
  assert.match(updateErrorResult('disabled', null, '1.4.0').message, /已禁用/);
  assert.match(updateErrorResult('malformed', null, '1.4.0').message, /格式异常/);
  assert.match(updateErrorResult('http', 500, '1.4.0').message, /HTTP 500/);
});

check('v1.3.0 → v1.4.0：新字段补默认，用户已有值全部保留', () => {
  const legacy = {
    workStart: '10:00',
    workEnd: '19:00',
    restMode: 'monthly',
    customRestDays: [0, 6],
    alternating: { anchorDate: WEEK1_MONDAY, anchorIsDouble: true },
    weeklyPlan: {
      '2026-10-26': 'single',
      '2026-11-02': 'single',
      '2026-11-23': 'single',
      '2026-11-30': 'double',
    },
    lunch: { enabled: true, start: '12:00', end: '13:00' },
    overtime: { enabled: true, start: '19:00' },
    notifyAtEnd: true,
    notifyBeforeMinutes: 5,
    launchAtLogin: true,
  };
  const upgraded = sanitizeSettings(legacy, MONDAY);
  assert.equal(upgraded.workStart, '10:00');
  assert.equal(upgraded.workEnd, '19:00');
  assert.equal(upgraded.restMode, 'monthly');
  assert.deepEqual(upgraded.weeklyPlan, legacy.weeklyPlan);
  assert.deepEqual(upgraded.lunch, legacy.lunch);
  assert.deepEqual(upgraded.overtime, legacy.overtime);
  assert.equal(upgraded.notifyAtEnd, true);
  assert.equal(upgraded.notifyBeforeMinutes, 5);
  assert.equal(upgraded.launchAtLogin, true);
  // 新字段默认值
  assert.deepEqual(upgraded.water, { ...WATER_DEFAULTS });
  assert.deepEqual(upgraded.rest, { ...REST_DEFAULTS });
  assert.deepEqual(upgraded.appearance, { ...APPEARANCE_DEFAULTS });
  assert.equal(upgraded.updateRepo, DEFAULT_UPDATE_REPO);
  assert.equal(upgraded.lastSeenVersion, '');
});

check('sanitize water/rest：范围外回退默认，合法值保留', () => {
  assert.deepEqual(
    sanitizeWaterSettings({
      enabled: false,
      intervalMinutes: 30,
      goalMl: 3000,
      cupMl: 300,
      workHoursOnly: false,
    }),
    {
      enabled: false,
      intervalMinutes: 30,
      goalMl: 3000,
      cupMl: 300,
      workHoursOnly: false,
    },
  );
  assert.deepEqual(sanitizeWaterSettings({ intervalMinutes: 0 }), {
    ...WATER_DEFAULTS,
  });
  assert.deepEqual(sanitizeRestSettings({ intervalMinutes: 601, durationMinutes: 500 }), {
    ...REST_DEFAULTS,
  });
  assert.deepEqual(
    sanitizeRestSettings({
      enabled: false,
      intervalMinutes: 60,
      durationMinutes: 10,
      workHoursOnly: false,
    }),
    {
      enabled: false,
      intervalMinutes: 60,
      durationMinutes: 10,
      workHoursOnly: false,
    },
  );
  // 数值字符串也接受（手写 settings.json 的容错）
  assert.equal(sanitizeWaterSettings({ goalMl: '2500' }).goalMl, 2500);
});

check('sanitizeAppearance / normalizeUpdateRepo / lastSeenVersion', () => {
  assert.deepEqual(sanitizeAppearance({}), { ...APPEARANCE_DEFAULTS });
  assert.deepEqual(
    sanitizeAppearance({
      themeMode: 'sun',
      accent: '#4a90d9',
      sunrise: '7:05',
      sunset: '17:45',
    }),
    {
      themeMode: 'sun',
      accent: '#4A90D9',
      sunrise: '07:05',
      sunset: '17:45',
    },
  );
  // 非法模式 / 颜色 / 倒序时间回退默认
  assert.deepEqual(
    sanitizeAppearance({
      themeMode: 'auto',
      accent: 'red',
      sunrise: '18:00',
      sunset: '06:00',
    }),
    { ...APPEARANCE_DEFAULTS },
  );

  assert.equal(normalizeUpdateRepo('BALLBALLUUUUU/WORK-OR-RUN'), 'BALLBALLUUUUU/WORK-OR-RUN');
  assert.equal(normalizeUpdateRepo(' https://github.com/a/b.git '), 'a/b');
  for (const bad of ['', 'a', 'a/b/c', 'a b/c', null, 5]) {
    assert.equal(normalizeUpdateRepo(bad), null, String(bad));
  }
  assert.equal(normalizeUpdateRepo('/a/b'), 'a/b');
  assert.equal(sanitizeLastSeenVersion('v1.4.0'), '1.4.0');
  assert.equal(sanitizeLastSeenVersion('1.4'), '1.4.0');
  assert.equal(sanitizeLastSeenVersion('nope'), '');
  assert.equal(sanitizeLastSeenVersion(null), '');
});

check('validateSettings：喝水提醒范围（间隔/目标/每次）', () => {
  for (const water of [
    { intervalMinutes: 0 },
    { intervalMinutes: 601 },
    { intervalMinutes: 1.5 },
    { goalMl: 99 },
    { goalMl: 10001 },
    { cupMl: 49 },
    { cupMl: 2001 },
    { enabled: 'yes' },
    { workHoursOnly: 'yes' },
    [],
  ]) {
    const result = validateSettings(validPayload({ water }), MONDAY);
    assert.equal(result.ok, false, JSON.stringify(water));
    assert.match(result.error, /喝水|提醒|目标|喝水量|仅工作时间/);
  }
  const ok = validateSettings(
    validPayload({
      water: {
        enabled: true,
        intervalMinutes: 30,
        goalMl: 2500,
        cupMl: 300,
        workHoursOnly: false,
      },
    }),
    MONDAY,
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.settings.water.intervalMinutes, 30);
  assert.equal(ok.settings.water.goalMl, 2500);
  assert.equal(ok.settings.water.cupMl, 300);
  assert.equal(ok.settings.water.workHoursOnly, false);
  // 旧调用方不传 water 仍然合法
  assert.equal(validateSettings(validPayload(), MONDAY).ok, true);
});

check('validateSettings：休息提醒范围（间隔/时长）', () => {
  for (const rest of [
    { intervalMinutes: 0 },
    { intervalMinutes: 601 },
    { durationMinutes: 0 },
    { durationMinutes: 121 },
    { enabled: 1 },
    { workHoursOnly: 0 },
    'x',
  ]) {
    const result = validateSettings(validPayload({ rest }), MONDAY);
    assert.equal(result.ok, false, JSON.stringify(rest));
    assert.match(result.error, /休息|提醒|仅工作时间/);
  }
  const ok = validateSettings(
    validPayload({
      rest: {
        enabled: false,
        intervalMinutes: 90,
        durationMinutes: 15,
        workHoursOnly: true,
      },
    }),
    MONDAY,
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.settings.rest.durationMinutes, 15);
  assert.equal(ok.settings.rest.enabled, false);
});

check('validateSettings：主题 / 高亮颜色 / 日出日落 / 更新源', () => {
  for (const appearance of [
    { themeMode: 'auto' },
    { accent: '#12345' },
    { accent: 'orange' },
    { sunrise: '25:00' },
    { sunset: '下午' },
    { sunrise: '18:00', sunset: '06:00' },
  ]) {
    const result = validateSettings(validPayload({ appearance }), MONDAY);
    assert.equal(result.ok, false, JSON.stringify(appearance));
    assert.match(result.error, /主题|颜色|日出|日落/);
  }
  const okAppearance = validateSettings(
    validPayload({
      appearance: {
        themeMode: 'dark',
        accent: '#8e7cc3',
        sunrise: '06:00',
        sunset: '19:00',
      },
    }),
    MONDAY,
  );
  assert.equal(okAppearance.ok, true);
  assert.equal(okAppearance.settings.appearance.accent, '#8E7CC3');
  assert.equal(okAppearance.settings.appearance.themeMode, 'dark');

  for (const updateRepo of ['', 'a', 'a/b/c', 'https://gitlab.com/a/b']) {
    const result = validateSettings(validPayload({ updateRepo }), MONDAY);
    assert.equal(result.ok, false, updateRepo);
    assert.match(result.error, /更新源/);
  }
  assert.equal(
    validateSettings(validPayload({ updateRepo: 'owner/repo' }), MONDAY).ok,
    true,
  );
  assert.equal(validateSettings(validPayload(), MONDAY).ok, true);
});

check('normalizeAccent：预设颜色全部合法，#RGB 展开，拒绝非法', () => {
  for (const preset of ACCENT_PRESETS) {
    assert.equal(normalizeAccent(preset), preset);
  }
  assert.equal(normalizeAccent('#f5a65b'), '#F5A65B');
  assert.equal(normalizeAccent('#abc'), '#AABBCC');
  assert.equal(normalizeAccent(' #4A90D9 '), '#4A90D9');
  for (const bad of ['#12345', '123456', '#GGGGGG', 'red', null, '#1234567', 42]) {
    assert.equal(normalizeAccent(bad), null, String(bad));
  }
  assert.ok(THEME_MODES.includes('sun') && THEME_MODES.includes('system'));
});

check('resolveTheme：system / light / dark / sun 及日出日落边界', () => {
  const system = { ...APPEARANCE_DEFAULTS, themeMode: 'system' };
  assert.equal(resolveTheme(system, local(2026, 11, 9, 22), false), 'light');
  assert.equal(resolveTheme(system, local(2026, 11, 9, 22), true), 'dark');
  assert.equal(
    resolveTheme({ ...system, themeMode: 'light' }, local(2026, 11, 9, 22), true),
    'light',
  );
  assert.equal(
    resolveTheme({ ...system, themeMode: 'dark' }, local(2026, 11, 9, 12), false),
    'dark',
  );

  const sun = { ...APPEARANCE_DEFAULTS, themeMode: 'sun' };
  assert.equal(resolveTheme(sun, local(2026, 11, 9, 6, 29), true), 'dark');
  assert.equal(resolveTheme(sun, local(2026, 11, 9, 6, 30), true), 'light');
  assert.equal(resolveTheme(sun, local(2026, 11, 9, 12, 0), true), 'light');
  assert.equal(resolveTheme(sun, local(2026, 11, 9, 17, 59), false), 'light');
  assert.equal(resolveTheme(sun, local(2026, 11, 9, 18, 0), false), 'dark');
  assert.equal(resolveTheme(sun, local(2026, 11, 9, 23, 59), false), 'dark');
  // 自定义日出 / 日落
  const custom = { ...sun, sunrise: '07:15', sunset: '17:45' };
  assert.equal(resolveTheme(custom, local(2026, 11, 9, 7, 0)), 'dark');
  assert.equal(resolveTheme(custom, local(2026, 11, 9, 7, 15)), 'light');
  assert.equal(resolveTheme(custom, local(2026, 11, 9, 17, 44)), 'light');
  assert.equal(resolveTheme(custom, local(2026, 11, 9, 17, 45)), 'dark');
  // 非法倒序回退 06:30–18:00
  assert.equal(
    resolveTheme({ ...sun, sunrise: '18:00', sunset: '06:00' }, local(2026, 11, 9, 12, 0)),
    'light',
  );
});

check('sanitizeWaterState：跨天重置 / 丢弃非法记录 / total 重算', () => {
  const today = '2026-11-09';
  assert.deepEqual(sanitizeWaterState(null, today), {
    day: today,
    totalMl: 0,
    records: [],
  });
  assert.deepEqual(
    sanitizeWaterState(
      { day: '2026-11-08', totalMl: 1000, records: [{ at: '09:00', ml: 500 }] },
      today,
    ),
    { day: today, totalMl: 0, records: [] },
  );
  const messy = sanitizeWaterState(
    {
      day: today,
      totalMl: 9999,
      records: [
        { at: '9:05', ml: 250 },
        { at: '25:00', ml: 100 },
        { at: '10:00', ml: 'x' },
        { at: '11:00', ml: 150 },
        null,
        'x',
      ],
    },
    today,
  );
  assert.equal(messy.totalMl, 400);
  assert.deepEqual(messy.records, [
    { at: '09:05', ml: 250 },
    { at: '11:00', ml: 150 },
  ]);
  // 只有 totalMl 的旧格式（兼容手写文件）
  assert.deepEqual(sanitizeWaterState({ day: today, totalMl: 750 }, today), {
    day: today,
    totalMl: 750,
    records: [],
  });
  assert.deepEqual(sanitizeWaterState('garbage', today), {
    day: today,
    totalMl: 0,
    records: [],
  });
});

check('addWaterRecord / clearWaterState：追加时间水量、跨天重置、非法金额', () => {
  let state = { day: '2026-11-09', totalMl: 0, records: [] };
  state = addWaterRecord(state, 250, local(2026, 11, 9, 14, 5));
  state = addWaterRecord(state, 150, local(2026, 11, 9, 15, 30));
  assert.equal(state.totalMl, 400);
  assert.deepEqual(state.records, [
    { at: '14:05', ml: 250 },
    { at: '15:30', ml: 150 },
  ]);
  for (const bad of [0, -1, 2001, 1.5, 'x', null]) {
    assert.equal(addWaterRecord(state, bad, local(2026, 11, 9, 16, 0)), null);
  }
  const nextDay = addWaterRecord(state, 200, local(2026, 11, 10, 9, 0));
  assert.equal(nextDay.day, '2026-11-10');
  assert.equal(nextDay.totalMl, 200);
  assert.equal(nextDay.records.length, 1);
  assert.deepEqual(nextDay.records[0], { at: '09:00', ml: 200 });
  assert.deepEqual(clearWaterState(local(2026, 11, 9, 12, 34)), {
    day: '2026-11-09',
    totalMl: 0,
    records: [],
  });
});

check('waterProgress：百分比四舍五入、封顶 100、非法目标回退', () => {
  assert.deepEqual(waterProgress(750, 2000), {
    totalMl: 750,
    goalMl: 2000,
    percent: 38,
    reached: false,
  });
  assert.equal(waterProgress(2000, 2000).percent, 100);
  assert.equal(waterProgress(2000, 2000).reached, true);
  assert.equal(waterProgress(3000, 2000).percent, 100);
  assert.equal(waterProgress(3000, 2000).reached, true);
  assert.equal(waterProgress(-5, 2000).totalMl, 0);
  assert.equal(waterProgress(100, 50).goalMl, 2000); // 越界目标回退默认
  assert.equal(waterProgress(0, 2000).percent, 0);
});

check('isWithinWorkHours：工作日 [workStart, workEnd) 边界、休息日', () => {
  const s = makeSettings(); // 09:00–18:00，双休
  assert.equal(isWithinWorkHours(s, local(2026, 11, 9, 8, 59)), false);
  assert.equal(isWithinWorkHours(s, local(2026, 11, 9, 9, 0)), true);
  assert.equal(isWithinWorkHours(s, local(2026, 11, 9, 12, 30)), true);
  assert.equal(isWithinWorkHours(s, local(2026, 11, 9, 17, 59)), true);
  assert.equal(isWithinWorkHours(s, local(2026, 11, 9, 18, 0)), false);
  assert.equal(isWithinWorkHours(s, local(2026, 11, 14, 10, 0)), false); // 周六
  assert.equal(isWithinWorkHours(s, local(2026, 11, 15, 10, 0)), false); // 周日
  // 单休：周六是工作日
  assert.equal(
    isWithinWorkHours(makeSettings({ restMode: 'single' }), local(2026, 11, 14, 10, 0)),
    true,
  );
  // 非法设置会先回退默认 09:00–18:00，仍能安全返回布尔值
  assert.equal(
    isWithinWorkHours({ workStart: 'x', workEnd: 'y' }, local(2026, 11, 9, 20, 0)),
    false,
  );
});

check('reminderEligible：开关 / 仅工作时间 / 关闭限制后任意时间', () => {
  const s = makeSettings();
  const water = sanitizeWaterSettings({});
  assert.equal(reminderEligible(water, s, local(2026, 11, 9, 10, 0)), true);
  assert.equal(
    reminderEligible({ ...water, enabled: false }, s, local(2026, 11, 9, 10, 0)),
    false,
  );
  assert.equal(
    reminderEligible({ ...water, workHoursOnly: false }, s, local(2026, 11, 14, 10, 0)),
    true,
  );
  assert.equal(reminderEligible(water, s, local(2026, 11, 14, 10, 0)), false);
  assert.equal(reminderEligible(null, s, local(2026, 11, 9, 10, 0)), false);
});

check('reminderDue：间隔 / 基线 / 跨天 / 工作时间外 / 关闭', () => {
  const s = makeSettings();
  const water = sanitizeWaterSettings({ intervalMinutes: 45 });
  const baseline = local(2026, 11, 9, 10, 0).getTime();
  assert.equal(
    reminderDue(water, s, local(2026, 11, 9, 10, 45), baseline, '2026-11-09'),
    true,
  );
  assert.equal(
    reminderDue(water, s, local(2026, 11, 9, 10, 44, 59), baseline, '2026-11-09'),
    false,
  );
  assert.equal(reminderDue(water, s, local(2026, 11, 9, 11, 0), null, '2026-11-09'), false);
  // 基线来自昨天 -> 不触发（主进程会重置基线）
  assert.equal(
    reminderDue(
      water,
      s,
      local(2026, 11, 9, 10, 45),
      local(2026, 11, 8, 10, 45).getTime(),
      '2026-11-08',
    ),
    false,
  );
  // 工作时间外不触发
  assert.equal(
    reminderDue(
      water,
      s,
      local(2026, 11, 9, 8, 0),
      local(2026, 11, 9, 7, 0).getTime(),
      '2026-11-09',
    ),
    false,
  );
  // 1 分钟间隔
  assert.equal(
    reminderDue(
      { ...water, intervalMinutes: 1 },
      s,
      local(2026, 11, 9, 10, 1),
      local(2026, 11, 9, 10, 0).getTime(),
      '2026-11-09',
    ),
    true,
  );
  assert.equal(
    reminderDue(
      { ...water, enabled: false },
      s,
      local(2026, 11, 9, 12, 0),
      baseline,
      '2026-11-09',
    ),
    false,
  );
  // 仅工作时间关闭后，周末也会到点
  assert.equal(
    reminderDue(
      { ...water, workHoursOnly: false },
      s,
      local(2026, 11, 14, 10, 45),
      local(2026, 11, 14, 10, 0).getTime(),
      '2026-11-14',
    ),
    true,
  );
});

check('reminderNotification：喝水 / 休息文案与时长回退', () => {
  assert.deepEqual(reminderNotification('water', {}), {
    title: '喝水提醒',
    body: '该喝水了 · 起身接杯水，补充点水分。',
  });
  assert.deepEqual(reminderNotification('rest', { durationMinutes: 5 }), {
    title: '休息提醒',
    body: '该休息一下了 · 起身活动 5 分钟',
  });
  assert.deepEqual(reminderNotification('rest', { durationMinutes: 999 }), {
    title: '休息提醒',
    body: '该休息一下了 · 起身活动 5 分钟',
  });
});

check('shouldAutoOpenSettings：首次安装 / 版本变化 / 同版本 / 自检', () => {
  assert.equal(
    shouldAutoOpenSettings({ hadSettingsFile: false, appVersion: '1.4.0' }),
    true,
  );
  assert.equal(
    shouldAutoOpenSettings({
      hadSettingsFile: true,
      lastSeenVersion: '1.3.0',
      appVersion: '1.4.0',
    }),
    true,
  );
  assert.equal(
    shouldAutoOpenSettings({
      hadSettingsFile: true,
      lastSeenVersion: '',
      appVersion: '1.4.0',
    }),
    true,
  );
  assert.equal(
    shouldAutoOpenSettings({
      hadSettingsFile: true,
      lastSeenVersion: '1.4.0',
      appVersion: '1.4.0',
    }),
    false,
  );
  assert.equal(
    shouldAutoOpenSettings({
      hadSettingsFile: false,
      appVersion: '1.4.0',
      selftest: true,
    }),
    false,
  );
  assert.equal(
    shouldAutoOpenSettings({
      hadSettingsFile: true,
      lastSeenVersion: '1.3.0',
      appVersion: '1.4.0',
      selftest: true,
    }),
    false,
  );
  assert.equal(
    shouldAutoOpenSettings({
      hadSettingsFile: true,
      lastSeenVersion: '1.4.0',
      appVersion: '',
    }),
    false,
  );
});

console.log(
  `\n${passed} 项检查通过${failed ? `，${failed} 项失败` : ''}${
    process.exitCode ? '（存在失败项）' : ''
  }`,
);
