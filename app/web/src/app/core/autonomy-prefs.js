// 主动消息的「时段与上限」偏好：她几点到几点可以来找你、一天最多几条、隔多久一条。
//
// 为什么单独一个键而不是塞进 chatprefs：这组值管的是「能不能发」，
// 跟「这轮请求怎么拼」不是一件事；换模型/换平台不该把它们一起重置。
//
// 存的是 localStorage —— native 后台任务读不到 web 的存储，所以真正的
// 免打扰与间隔还得由 web 在 pushMaterial 时推给 native（见 core/proactive.js）。
// 这里的判定负责两件事：设置页当场显示合不合法、以及 web 在场时的排程顺延。
//
// 字段名说明：quietFrom/quietTo 是本模块的主名，读出来时额外带
// quietStart/quietEnd 镜像，方便按契约名写的调用方直接用。
import { sleepWindowOf } from './activity.js';

const KEY = 'ellen.autonomy.v1';

const HOUR = 60 * 60 * 1000;

/**
 * 三档节奏的 id 白名单。真身在 core/proactive.js 的 RHYTHMS，
 * 这里只留 id —— 因为「她多久找你一次」这个选择必须落盘，
 * 否则设置页重新 mount 又会读回默认的「自然一些」（2026-11-20 修的 bug1）。
 */
export const RHYTHM_IDS = ['often', 'normal', 'rare'];

export const DEFAULT_AUTONOMY = {
  enabled: true,
  // 主动消息的节奏档位（设置页那三个按钮）。改这里等于改默认档。
  rhythmId: 'normal',
  intervalH: 4,
  // 免打扰窗默认跟着学出来的作息走（corectivity.js 从消息时间戳算），
  // 关掉才用下面这两个手设的整点。跟着作息是为了「他也睡了就别吵」。
  followActivity: true,
  quietFrom: 22,
  quietTo: 8,
  dailyMax: 3,
  // 「每天最少几条」。0 = 不强制（默认，保持老行为）。
  // 注意它跟 dailyMax 不是一回事：dailyMax 管「别烦我」，dailyMin 管「别把我晾着」。
  dailyMin: 0,
};

/** 设置页可选的间隔/条数（跟 UI 上的按钮一一对应，别只改一边）。 */
export const INTERVAL_OPTIONS = [2, 4, 6, 8];
export const DAILY_OPTIONS = [2, 3, 4, 6];

/** 「每天最少」的选项：比上限多一个 0（不强制）。 */
export const DAILY_MIN_OPTIONS = [0, 2, 3, 4, 6];

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 本地日期键：跨零点要能分清「今天」和「昨天」。 */
function dayKey(date) {
  const d = date || new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function readRaw() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    // 存坏了就当没存过：这组值的默认值是安全的，不能因为一次写坏就整块崩
    return null;
  }
}

/** 把任意输入揉成合法形状；缺的补默认，越界的夹回去。 */
function normalize(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const quietFrom = clampInt(
    src.quietFrom !== undefined ? src.quietFrom : src.quietStart,
    0,
    23,
    DEFAULT_AUTONOMY.quietFrom
  );
  const quietTo = clampInt(
    src.quietTo !== undefined ? src.quietTo : src.quietEnd,
    0,
    23,
    DEFAULT_AUTONOMY.quietTo
  );
  const prefs = {
    enabled: src.enabled === undefined ? DEFAULT_AUTONOMY.enabled : !!src.enabled,
    // 只认白名单里的三档：老数据/手改坏了就回落默认，不让一个野值把按钮全点亮不中
    rhythmId: RHYTHM_IDS.includes(src.rhythmId) ? src.rhythmId : DEFAULT_AUTONOMY.rhythmId,
    followActivity:
      src.followActivity === undefined ? DEFAULT_AUTONOMY.followActivity : !!src.followActivity,
    intervalH: clampInt(src.intervalH, 1, 24, DEFAULT_AUTONOMY.intervalH),
    quietFrom,
    quietTo,
    dailyMax: clampInt(src.dailyMax, 1, 20, DEFAULT_AUTONOMY.dailyMax),
    dailyMin: clampInt(src.dailyMin, 0, 20, DEFAULT_AUTONOMY.dailyMin),
    sentToday: clampInt(src.sentToday, 0, 999, 0),
    sentDay: typeof src.sentDay === 'string' ? src.sentDay : '',
  };
  // 下限不许超过上限：用户把「最少」拧到比「最多」还大时，抬上限而不是砍下限——
  // 他想要的是「至少 N 条」，砍成 M 条等于把话吞回去。
  if (prefs.dailyMin > prefs.dailyMax) prefs.dailyMax = prefs.dailyMin;
  // 契约名镜像：同一份数据两个名字，读的人不用再猜
  prefs.quietStart = prefs.quietFrom;
  prefs.quietEnd = prefs.quietTo;
  return prefs;
}

function persist(prefs) {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        enabled: prefs.enabled,
        rhythmId: prefs.rhythmId,
        intervalH: prefs.intervalH,
        quietFrom: prefs.quietFrom,
        quietTo: prefs.quietTo,
        dailyMax: prefs.dailyMax,
        dailyMin: prefs.dailyMin,
        sentToday: prefs.sentToday,
        sentDay: prefs.sentDay,
      })
    );
  } catch (err) {
    console.warn('[autonomy] 存不下', err);
  }
}

/** 读偏好。读不到/坏数据一律回落默认值，不会抛。 */
export function readAutonomyPrefs() {
  return normalize(readRaw());
}

/**
 * 写偏好（增量）。
 * @param {object} patch 只给要改的字段；quietStart/quietEnd 也认
 * @returns {object} 写完后的完整偏好
 */
export function writeAutonomyPrefs(patch) {
  const cur = normalize(readRaw());
  const next = normalize({ ...cur, ...(patch && typeof patch === 'object' ? patch : {}) });
  persist(next);
  return next;
}

/** 恢复默认（把整条记录清掉，不留半套）。 */
export function resetAutonomyPrefs() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* 清不掉就按默认值用 */
  }
  return normalize(null);
}

/**
 * 现在是否落在免打扰时段。支持跨零点（22 点到 8 点）。
 * 起止相同视为「不设免打扰」—— 24 小时全静音不是任何人想要的结果。
 * @param {Date} [now]
 * @param {object} [prefs] 不给就现读
 */
export function isWithinQuiet(now, prefs) {
  const when = now instanceof Date ? now : new Date();
  const p = prefs || readAutonomyPrefs();
  const minute = when.getHours() * 60 + when.getMinutes();
  if (p.followActivity !== false) {
    // 学出来的作息：分钟级，跨夜也对（sleepWindowOf 已经 normalize 过）
    const learned = sleepWindowOf(null);
    if (learned && learned.start !== learned.end) {
      return learned.start < learned.end
        ? minute >= learned.start && minute < learned.end
        : minute >= learned.start || minute < learned.end;
    }
  }
  const hour = when.getHours();
  const from = p.quietFrom !== undefined ? p.quietFrom : p.quietStart;
  const to = p.quietTo !== undefined ? p.quietTo : p.quietEnd;
  if (from === to) return false;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

/** 契约名（`isQuietNow(prefs, date)`）：参数顺序跟 isWithinQuiet 相反，两种传法都认。 */
export function isQuietNow(prefs, date) {
  let p = null;
  let when = null;
  if (prefs instanceof Date) when = prefs;
  else if (prefs && typeof prefs === 'object') p = prefs;
  if (date instanceof Date) when = date;
  return isWithinQuiet(when || new Date(), p);
}

/** 今天已经发了几条（跨天自动归零）。 */
export function readSentToday(now) {
  const p = normalize(readRaw());
  if (p.sentDay !== dayKey(now)) return 0;
  return p.sentToday;
}

/** 记一条「已经发出去了」。web 只在真的收到消息时数得到（后台发送时 web 不在场）。 */
export function markSentToday(now) {
  const when = now instanceof Date ? now : new Date();
  const p = normalize(readRaw());
  const today = dayKey(when);
  const next = normalize({
    ...p,
    sentToday: p.sentDay === today ? p.sentToday + 1 : 1,
    sentDay: today,
  });
  persist(next);
  return next.sentToday;
}

/**
 * 现在能不能发一条。
 * @param {{sentToday?:number, lastAt?:number, now?:Date}} [ctx]
 *   sentToday 不给就按本地记的今天条数算；lastAt 是上一条发出的时间戳
 * @returns {{ok:boolean, reason:''|'disabled'|'quiet'|'daily'|'interval'}}
 */
export function canPingNow(ctx = {}) {
  const now = ctx.now instanceof Date ? ctx.now : new Date();
  const prefs = readAutonomyPrefs();
  if (!prefs.enabled) return { ok: false, reason: 'disabled' };
  if (isWithinQuiet(now, prefs)) return { ok: false, reason: 'quiet' };

  const sent = Number.isFinite(Number(ctx.sentToday)) ? Number(ctx.sentToday) : readSentToday(now);
  if (sent >= prefs.dailyMax) return { ok: false, reason: 'daily' };

  const last = Number(ctx.lastAt) || 0;
  if (last > 0 && now.getTime() - last < prefs.intervalH * HOUR) {
    return { ok: false, reason: 'interval' };
  }
  return { ok: true, reason: '' };
}

/**
 * 今天还差几条才够「最少 N 条」。0 = 不需要补。
 *
 * 跟 canPingNow 分工：canPingNow 回答「现在能不能发」，这个回答「今天够不够」。
 * 两个都要过才允许补足发送。
 * @param {{sentToday?:number, now?:Date}} [ctx]
 */
export function topUpNeeded(ctx = {}) {
  const prefs = readAutonomyPrefs();
  if (!prefs.enabled || prefs.dailyMin <= 0) return 0;
  const now = ctx.now instanceof Date ? ctx.now : new Date();
  const sent = Number.isFinite(Number(ctx.sentToday))
    ? Number(ctx.sentToday)
    : readSentToday(now);
  // 上限优先：已经发满 dailyMax，就算没到 dailyMin 也不再补（上限是硬门）
  if (sent >= prefs.dailyMax) return 0;
  return Math.max(0, Math.min(prefs.dailyMin, prefs.dailyMax) - sent);
}

/** 契约名（`allowToday(prefs, sent)`）：只问条数，不问时段。 */export function allowToday(prefs, sent) {
  const p = prefs || readAutonomyPrefs();
  const used = Number.isFinite(Number(sent)) ? Number(sent) : 0;
  return !!p.enabled && used < p.dailyMax;
}

/** 间隔换算成毫秒，给 native 的 minGapMs 用。 */
export function intervalMs(prefs) {
  const p = prefs || readAutonomyPrefs();
  return p.intervalH * HOUR;
}

/**
 * 距离免打扰结束还有多久（毫秒）。不在免打扰里返回 0。
 * @param {Date} [now]
 * @param {object} [prefs]
 */
export function msUntilQuietEnd(now, prefs) {
  const when = now instanceof Date ? now : new Date();
  const p = prefs || readAutonomyPrefs();
  if (!isWithinQuiet(when, p)) return 0;
  const end = new Date(when.getTime());
  if (p.followActivity !== false) {
    const learned = sleepWindowOf(null);
    end.setHours(0, learned ? learned.end : p.quietTo, 0, 0);
  } else {
    end.setHours(p.quietTo, 0, 0, 0);
  }
  if (end.getTime() <= when.getTime()) end.setDate(end.getDate() + 1);
  return end.getTime() - when.getTime();
}

/** 距离本地零点还有多久（毫秒）：今日条数用完时用它顺延。 */
export function msUntilNextDay(now) {
  const when = now instanceof Date ? now : new Date();
  const next = new Date(when.getTime());
  next.setHours(24, 0, 0, 0);
  return next.getTime() - when.getTime();
}
