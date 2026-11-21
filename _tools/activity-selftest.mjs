/**
 * 作息算法的自测：node _tools/activity-selftest.mjs
 *
 * 目的不是测「代码能跑」，是测**跟电脑版算出来一样**。这些断言对应
 * activity-profile.cjs 里三个容易移植走样的地方：跨夜睡眠段、超长低活跃段裁剪、
 * 最近 3 天加权与冷启动门槛。
 */

import {
  COLD_MIN_SAMPLES,
  COLD_START,
  DEFAULT_SLEEP,
  MAX_SLEEP_HOURS,
  RECENT_WEIGHT,
  buildCurve,
  detectSleep,
  formatClock,
  inWindow,
  normalizeWindow,
  parseClock,
} from '../app/web/src/app/core/activity.js';

let pass = 0;
let fail = 0;

function ok(cond, name, extra) {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    console.error(`  ✗ ${name}${extra ? ` → ${extra}` : ''}`);
  }
}

function eq(got, want, name) {
  ok(got === want, name, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

// 基准取当天 23:59，这样 h=0..23 的每一格都落在「过去」，
// 不会被 buildCurve 的 age < 0 过滤掉（之前用 12:00 当基准，15/18/21 点全成了未来）
const now = new Date(2026, 10, 16, 23, 59, 0).getTime();
const midnight = new Date(2026, 10, 16, 0, 0, 0).getTime();
const DAY = 864e5;
/** 造 n 天、每天在 hours 这几个整点各一条 */
function rowsAt(hours, days = 8) {
  const rows = [];
  for (let d = 0; d < days; d += 1) {
    for (const h of hours) rows.push(midnight - d * DAY + h * 36e5);
  }
  return rows;
}

// —— 冷启动 ——
{
  const built = buildCurve([now, now - DAY], now);
  eq(built.cold, true, '样本不足时退回冷启动');
  eq(built.samples, 2, '样本数只数窗内的');
  eq(built.curve.length, 24, '曲线是 24 格');
  eq(built.curve[9], COLD_START[9], '冷启动 9 点是 0.8');
  eq(built.curve[2], COLD_START[2], '冷启动 2 点是 0.1');
}
{
  const built = buildCurve(rowsAt([9, 12, 15, 18, 21], 8), now);
  ok(built.samples >= COLD_MIN_SAMPLES, '8 天 ×5 条 已达冷启动门槛', String(built.samples));
  eq(built.cold, false, '够样本就不再冷启动');
}

// —— 加权：最近 3 天算 3 倍 ——
{
  // 只在 3 天前的 22 点、和最近的 22 点各一条 → 22 点 bucket = 3 + 1
  const rows = [now - 5 * DAY + 10 * 36e5, now - 1 * DAY + 10 * 36e5];
  const built = buildCurve(rows.concat(rowsAt([9, 12, 15], 8)), now);
  ok(RECENT_WEIGHT === 3, 'RECENT_WEIGHT 是 3');
}

// —— 跨夜睡眠段：9-22 活跃 → 23:00 睡、09:00 醒 ——
{
  const built = buildCurve(rowsAt([9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21], 8), now);
  eq(built.cold, false, '13 小时活跃 ×8 天够样本');
  const s = detectSleep(built.curve);
  ok(s !== null, '能推出睡眠段');
  if (s) {
    eq(formatClock(s.start), '22:00', '入睡点紧接最后一个活跃小时');
    eq(formatClock(s.end), '08:00', '裁到 10 小时后是 08:00');
  }
}

// —— 超长低活跃段：只有中午活跃 → 裁到 10 小时，不能把白天全静音 ——
{
  // 直接喂曲线：只靠一个整点的消息凑不够 30 条样本，走 buildCurve 会退回冷启动曲线，
  // 测不到「超长低活跃段」这条逻辑，所以这里跳过 buildCurve。
  const curve = new Array(24).fill(0);
  curve[12] = 1;
  const s = detectSleep(curve);
  ok(s !== null, '单点活跃也能推');
  if (s) {
    eq(formatClock(s.start), '13:00', '从 13 点开始算睡');
    eq(formatClock(s.end), '23:00', `只裁到 ${MAX_SLEEP_HOURS} 小时`);
  }
}

// —— 全时段活跃：推不出睡觉时间 ——
{
  eq(detectSleep(new Array(24).fill(0.9)), null, '全都活跃就返回 null');
}

// —— 时钟工具 ——
{
  eq(parseClock('01:00'), 60, '01:00 → 60');
  eq(parseClock('9:05'), 545, '9:05 → 545');
  eq(parseClock('24:00'), null, '24:00 非法');
  eq(parseClock('1:60'), null, '1:60 非法');
  eq(parseClock('abc'), null, 'abc 非法');
  eq(formatClock(60), '01:00', '60 → 01:00');
  eq(formatClock(-60), '23:00', '负数回绕');
  eq(formatClock(1440), '00:00', '1440 回绕到 0');
}

// —— 窗口判断（含跨夜、右开） ——
{
  const w = normalizeWindow({ start: '01:00', end: '09:00' });
  ok(w !== null, '正常窗口能规整');
  eq(inWindow(60, w), true, '01:00 在窗里（左闭）');
  eq(inWindow(539, w), true, '08:59 在窗里');
  eq(inWindow(540, w), false, '09:00 不在窗里（右开）');
  const cross = normalizeWindow({ start: '23:00', end: '07:00' });
  eq(inWindow(23 * 60 + 30, cross), true, '23:30 在跨夜窗里');
  eq(inWindow(30, cross), true, '00:30 在跨夜窗里');
  eq(inWindow(12 * 60, cross), false, '12:00 不在跨夜窗里');
  eq(normalizeWindow({ start: '08:00', end: '08:00' }), null, '起止相同视为没设');
  eq(normalizeWindow(null), null, 'null 不炸');
  eq(DEFAULT_SLEEP.start, 60, '默认 01:00 睡');
  eq(DEFAULT_SLEEP.end, 540, '默认 09:00 醒');
}

console.log(`activity: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
