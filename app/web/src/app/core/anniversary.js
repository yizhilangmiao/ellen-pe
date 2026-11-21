// 纪念日：日历上被特别标出来的那些日子。
//
// 为什么不新建一张表：记录层（core/store/records.js）是「kind + value」的通用结构，
// 导出（core/store/export.js）也是按记录全量 dump。挂一个新 kind 就能跟着备份/
// 换机一起走，不用改 schema、不用改导出白名单。
//
// 三条口径（2026-11-21 老大拍的）：
//  1. 空日子点了要给一句提示，不能「点了什么也没发生」；
//  2. 2 月 29 日的纪念日，平年落到 2 月 28 日；
//  3. 纪念日在回忆页单独一段，不混进「记忆 / 共同经历」。
//
// 这个文件不碰 DOM、不碰渲染，只做日期与存取 —— 日期逻辑最容易出错，所以单独
// 放进 _临时/anniversary.test.mjs 里逐条验（闰年、跨年、平年 2-29）。
import { appendRecord, reviseRecord } from './store/records.js';
import { listLatest } from './store/library.js';

/** 记录类型。改它等于改历史数据，别动。 */
export const ANNIV_KIND = 'anniversary';

/** 只影响图标与颜色，不参与任何判断。 */
export const TONES = ['anniversary', 'birthday', 'first-meet', 'custom'];

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function pad2(n) {
  return String(n).padStart(2, '0');
}

export function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** 'YYYY-MM-DD' → {y, m(1-12), d}；格式不对或日期不存在就给 null。 */
export function parseDay(day) {
  const text = String(day || '');
  const hit = DAY_RE.exec(text);
  if (!hit) return null;
  const y = Number(hit[1]);
  const m = Number(hit[2]);
  const d = Number(hit[3]);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const probe = new Date(y, m - 1, d);
  if (probe.getFullYear() !== y || probe.getMonth() !== m - 1 || probe.getDate() !== d) return null;
  return { y, m, d };
}

export function formatDay(y, m, d) {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** 本地日的零点，用来算天数差（不能用 UTC，否则凌晨会差一天）。 */
export function startOfDay(input) {
  const d = input instanceof Date ? new Date(input.getTime()) : new Date(input || Date.now());
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function dayDiff(fromDate, toDate) {
  const ms = startOfDay(toDate).getTime() - startOfDay(fromDate).getTime();
  return Math.round(ms / 86400000);
}

/** 把一条记录的 value 洗干净；脏数据一律回落成「一次性、无标题」而不是抛错。 */
export function normalizeValue(value) {
  const v = value && typeof value === 'object' ? value : {};
  const parsed = parseDay(v.day);
  const day = parsed ? formatDay(parsed.y, parsed.m, parsed.d) : '';
  const tone = TONES.includes(v.tone) ? v.tone : 'anniversary';
  return {
    day,
    yearly: v.yearly !== false,
    title: String(v.title || '').slice(0, 20),
    note: String(v.note || '').slice(0, 60),
    tone,
    updatedAt: Number(v.updatedAt) || 0,
  };
}

/**
 * 这一年的落点。
 * - 每年重复：取月日；2 月 29 日在平年落到 2 月 28 日（老大 2026-11-21 定的）。
 * - 一次性：只有当年当月当日才对得上，其余年份返回 ''。
 */
export function occurrenceInYear(day, yearly, year) {
  const parsed = parseDay(day);
  if (!parsed) return '';
  if (!yearly) return parsed.y === year ? formatDay(year, parsed.m, parsed.d) : '';
  if (parsed.m === 2 && parsed.d === 29 && !isLeapYear(year)) return formatDay(year, 2, 28);
  return formatDay(year, parsed.m, parsed.d);
}

/**
 * 下一次（或最近一次）到来。
 * 返回 { key, daysAway, at }：daysAway>0 是将来的第几天，0 是今天，<0 是已经过去。
 * 一次性且已经过去的日子照旧返回（daysAway 为负），由调用方决定怎么显示 ——
 * 删掉它会让「去年今天」这种日子从列表里凭空消失，那是丢数据。
 */
export function nextOccurrence(day, yearly, now = Date.now()) {
  const parsed = parseDay(day);
  if (!parsed) return null;
  const today = startOfDay(now);
  const year = today.getFullYear();

  if (!yearly) {
    const key = formatDay(parsed.y, parsed.m, parsed.d);
    const at = new Date(parsed.y, parsed.m - 1, parsed.d);
    return { key, daysAway: dayDiff(today, at), at };
  }

  const thisYear = occurrenceInYear(day, true, year);
  const thisAt = new Date(`${thisYear}T00:00:00`);
  if (thisAt.getTime() >= today.getTime()) {
    return { key: thisYear, daysAway: dayDiff(today, thisAt), at: thisAt };
  }
  const nextYear = occurrenceInYear(day, true, year + 1);
  const nextAt = new Date(`${nextYear}T00:00:00`);
  return { key: nextYear, daysAway: dayDiff(today, nextAt), at: nextAt };
}

/**
 * 某年某月里，这些纪念日各落在哪几天。
 * 返回 Map<'YYYY-MM-DD', rows[]>，给日历标记用。
 */
export function markedDaysOfMonth(rows, year, monthIndex) {
  const map = new Map();
  const month = monthIndex + 1;
  for (const row of rows || []) {
    const v = normalizeValue(row.value);
    if (!v.day) continue;
    const key = occurrenceInYear(v.day, v.yearly, year);
    if (!key) continue;
    const parsed = parseDay(key);
    if (!parsed || parsed.m !== month) continue;
    const bucket = map.get(key);
    if (bucket) bucket.push({ row, value: v });
    else map.set(key, [{ row, value: v }]);
  }
  return map;
}

/**
 * 排序：先「还没到的」（近的在前），再「已经过去的」（近的在前）。
 * 一年只过一次的纪念日，daysAway 永远落在 0..365，所以天然是「下一个先到」。
 */
export function sortByUpcoming(rows, now = Date.now()) {
  return (rows || [])
    .map((row) => {
      const value = normalizeValue(row.value);
      const next = nextOccurrence(value.day, value.yearly, now);
      return { row, value, next, daysAway: next ? next.daysAway : 99999 };
    })
    .sort((a, b) => {
      const aFuture = a.daysAway >= 0;
      const bFuture = b.daysAway >= 0;
      if (aFuture !== bFuture) return aFuture ? -1 : 1;
      if (aFuture) return a.daysAway - b.daysAway;
      return b.daysAway - a.daysAway;
    });
}

/** 「还有 12 天」「就是今天」「已经过去 30 天」。 */
export function describeDaysAway(daysAway) {
  if (daysAway === 0) return '就是今天';
  if (daysAway > 0) return `还有 ${daysAway} 天`;
  return `已经过去 ${Math.abs(daysAway)} 天`;
}

export async function listAll() {
  const rows = await listLatest(ANNIV_KIND, { limit: 0 });
  return rows.filter((r) => r && r.value && normalizeValue(r.value).day);
}

export async function create(patch) {
  const value = normalizeValue({ ...patch, updatedAt: Date.now() });
  if (!value.day) throw new Error('纪念日缺少有效日期');
  return appendRecord({ kind: ANNIV_KIND, value });
}

export async function update(headId, patch) {
  if (!headId) throw new Error('缺少记录 id');
  const value = normalizeValue({ ...patch, updatedAt: Date.now() });
  if (!value.day) throw new Error('纪念日缺少有效日期');
  return reviseRecord(headId, value);
}

export async function remove(headId) {
  if (!headId) throw new Error('缺少记录 id');
  return reviseRecord(headId, {}, { deleted: true });
}
