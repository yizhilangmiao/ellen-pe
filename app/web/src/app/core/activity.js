/**
 * 作息学习（手机版）：从聊天时间戳学出「他一天里什么时候在、什么时候在睡」。
 * 全部本机计算，不上云、不写日志。
 *
 * 移植自电脑版 `艾莲电脑版\创作版\resources\app\src\activity-profile.cjs`，
 * 差别只有一处：电脑版把结果写 json 文件，这里写 localStorage —— 手机版没有
 * 可随意写的目录，几百字节的曲线塞 localStorage 最省事。算法与常量**逐字照搬**，
 * 改之前先去电脑版对一遍，两边算法分叉就会「同一个他，两端算出不同作息」。
 */

export const HOURS = 24;
const DAY_MS = 864e5;
export const RECOMPUTE_MS = 6 * 36e5; // 每 6 小时重算一次
export const WINDOW_DAYS = 7; // 只看最近 7 天
export const RECENT_DAYS = 3; // 最近 3 天加权
export const RECENT_WEIGHT = 3;
export const OLD_WEIGHT = 1;
export const COLD_MIN_SAMPLES = 30; // 少于这个数就退回冷启动曲线
export const ACTIVE_THRESHOLD = 0.35;
export const SLEEP_THRESHOLD = 0.15;
export const SLEEP_MIN_HOURS = 4; // 连续 4 小时不活跃才算睡觉
export const MAX_SLEEP_HOURS = 10; // 一天睡超过 10 小时不合常理

/** 冷启动：9-22 时 0.8，1-8 时 0.1，23 点与 0 点 0.2（那正是「睡前」窗口）。 */
export const COLD_START = [
  0.2, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1,
  0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8,
  0.2,
];

export const DEFAULT_SLEEP = { start: 60, end: 540 }; // 01:00 - 09:00

export const ACTIVITY_KEY = 'ellen.activity.v1';

/** "01:00" → 60；非法返回 null */
export function parseClock(text) {
  if (typeof text !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min)) return null;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** 60 → "01:00" */
export function formatClock(minute) {
  const n = ((Math.round(minute) % 1440) + 1440) % 1440;
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
}

/** 把 {start:"01:00",end:"09:00"} 规整成分钟数；非法返回 null */
export function normalizeWindow(window) {
  if (!window || typeof window !== 'object') return null;
  const start = parseClock(window.start);
  const end = parseClock(window.end);
  if (start == null || end == null) return null;
  if (start === end) return null;
  return { start, end };
}

/** 分钟数是否落在（可跨夜的）区间里 */
export function inWindow(minute, window) {
  if (!window) return false;
  const { start, end } = window;
  const m = ((Math.round(minute) % 1440) + 1440) % 1440;
  return start < end ? m >= start && m < end : m >= start || m < end;
}

/**
 * 从小时曲线里找睡眠段：连续 >= 4 小时 value < 0.15 的最长环形区间。
 * 找不到返回 null。
 */
export function detectSleep(curve) {
  if (!Array.isArray(curve) || curve.length !== HOURS) return null;
  const low = curve.map((v) => v < SLEEP_THRESHOLD);
  const anchor = low.findIndex((v) => !v);
  if (anchor < 0) return null; // 全时段都很活跃，推不出睡觉时间
  let best = null;
  let runStart = -1;
  let runLen = 0;
  for (let k = 1; k <= HOURS; k += 1) {
    const h = (anchor + k) % HOURS;
    if (low[h]) {
      if (runLen === 0) runStart = h;
      runLen += 1;
    } else if (runLen > 0) {
      if (runLen >= SLEEP_MIN_HOURS && (!best || runLen > best.len)) {
        best = { start: runStart, len: runLen };
      }
      runLen = 0;
    }
  }
  if (runLen >= SLEEP_MIN_HOURS && (!best || runLen > best.len)) {
    best = { start: runStart, len: runLen };
  }
  if (!best) return null;
  // 白天整天不在的人，最长低活跃段会横跨整个白天（如 23:00-18:00，19 小时）。
  // 那不是睡觉，按睡觉处理会把白天全静音。裁到合理睡眠长度。
  const len = Math.min(best.len, MAX_SLEEP_HOURS);
  return { start: best.start * 60, end: ((best.start + len) % HOURS) * 60 };
}

/** 某小时的活跃程度，0..1 */
export function activityAt(ms, curve) {
  if (!Array.isArray(curve) || curve.length !== HOURS) return 0;
  return curve[new Date(ms).getHours()] ?? 0;
}

export function isActiveAt(ms, curve, threshold = ACTIVE_THRESHOLD) {
  return activityAt(ms, curve) >= threshold;
}

/**
 * rows 可以是毫秒数、ISO 字符串，或带 at/createdAt 字段的对象。
 * 返回 {curve, samples, cold}
 */
export function buildCurve(rows, now = Date.now()) {
  const buckets = new Array(HOURS).fill(0);
  let samples = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const at =
      typeof row === 'number'
        ? row
        : Date.parse(row && typeof row === 'object' ? row.at ?? row.createdAt ?? row.time : row);
    if (!Number.isFinite(at)) continue;
    const age = now - at;
    if (age < 0 || age > WINDOW_DAYS * DAY_MS) continue;
    buckets[new Date(at).getHours()] += age <= RECENT_DAYS * DAY_MS ? RECENT_WEIGHT : OLD_WEIGHT;
    samples += 1;
  }
  if (samples < COLD_MIN_SAMPLES) {
    return { curve: COLD_START.slice(), samples, cold: true };
  }
  const max = Math.max(...buckets);
  return {
    curve: max > 0 ? buckets.map((v) => v / max) : COLD_START.slice(),
    samples,
    cold: false,
  };
}

const EMPTY = {
  version: 1,
  computedAt: null,
  curve: COLD_START.slice(),
  samples: 0,
  cold: true,
  sleep: null,
};

/** 读缓存。存坏了/隐私模式读不到都退回冷启动，绝不抛。 */
export function readActivity() {
  try {
    const raw = JSON.parse(localStorage.getItem(ACTIVITY_KEY) || 'null');
    if (!raw || raw.version !== 1) return { ...EMPTY, curve: COLD_START.slice() };
    if (!Array.isArray(raw.curve) || raw.curve.length !== HOURS) return { ...EMPTY, curve: COLD_START.slice() };
    if (raw.curve.some((v) => !Number.isFinite(v))) return { ...EMPTY, curve: COLD_START.slice() };
    return {
      version: 1,
      computedAt: typeof raw.computedAt === 'string' ? raw.computedAt : null,
      curve: raw.curve.slice(),
      samples: Number.isInteger(raw.samples) ? raw.samples : 0,
      cold: raw.cold !== false,
      sleep: normalizeWindow(raw.sleep),
    };
  } catch {
    return { ...EMPTY, curve: COLD_START.slice() };
  }
}

export function writeActivity(data) {
  try {
    localStorage.setItem(ACTIVITY_KEY, JSON.stringify(data));
    return true;
  } catch {
    return false; // 配额满/隐私模式：算出来的东西丢了就丢了，别影响聊天
  }
}

/** 重算并存盘 */
export function refreshActivity(rows, now = Date.now()) {
  const built = buildCurve(rows, now);
  const data = {
    version: 1,
    computedAt: new Date(now).toISOString(),
    curve: built.curve,
    samples: built.samples,
    cold: built.cold,
    sleep: detectSleep(built.curve),
  };
  writeActivity(data);
  return data;
}

/** 到 6 小时了才重算，否则原样返回 */
export function maybeRefreshActivity(rows, now = Date.now()) {
  const cur = readActivity();
  const at = cur.computedAt ? Date.parse(cur.computedAt) : 0;
  if (at && now - at >= 0 && now - at < RECOMPUTE_MS) return cur;
  return refreshActivity(rows, now);
}

/** 手改优先于推断；都没有就用 01:00-09:00 */
export function sleepWindowOf(override, data = readActivity()) {
  return normalizeWindow(override) || data.sleep || DEFAULT_SLEEP;
}

export function isSleepingAt(ms = Date.now(), override, data = readActivity()) {
  const window = sleepWindowOf(override, data);
  const d = new Date(ms);
  return inWindow(d.getHours() * 60 + d.getMinutes(), window);
}

export function sleepWindowText(override, data = readActivity()) {
  const w = sleepWindowOf(override, data);
  return { start: formatClock(w.start), end: formatClock(w.end) };
}

/**
 * 给他看的一句话：她从这个曲线里读出什么。
 * 设置页用它解释「为什么免打扰窗是这个值」。
 */
export function describeActivity(data = readActivity()) {
  const w = sleepWindowOf(null, data);
  const { start, end } = { start: formatClock(w.start), end: formatClock(w.end) };
  if (data.cold) return `还在摸索你的作息（攒够 ${COLD_MIN_SAMPLES} 条消息才准），先按 ${start}–${end} 猜。`;
  return `照你的作息看，你大概 ${start} 睡、${end} 醒（最近 ${WINDOW_DAYS} 天 ${data.samples} 条消息）。`;
}
