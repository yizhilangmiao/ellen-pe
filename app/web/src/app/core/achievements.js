// 成就：12 枚一次性徽章。解锁只落一个时间戳，不再弹第二次、不回滚。
//
// 判据全部写在 check(stats) 里，stats 由 resolveStats() 现算（也可以由调用方直接喂）。
// 为什么把判据独立成纯函数：徽章是「设定」，将来加第 13 枚只要往 LIST 里塞一条，
// 不用改解锁流程、不用改界面。
import { getMeta, putMeta } from './store/records.js';
import { listLatest } from './store/library.js';
import { dayKey, snapshot as bondSnapshot, stageIndexOf } from './bond.js';
import { readCheckin } from './checkin.js';
import { listLetters } from './letter.js';

export const META_KEY = 'achievements-v1';

/** 一次判定最多扫多少条消息：只为了判「有没有深夜说过话 / 存过图 / 连聊几天」。 */
const MESSAGE_SCAN = 1500;

function dayNumber(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return Math.floor(Date.UTC(y, (m || 1) - 1, d || 1) / 86400000);
}

/** 一串日期里最长连续天数。 */
function maxRun(keys) {
  const list = [...keys].sort();
  let best = 0;
  let run = 0;
  let prev = null;
  for (const k of list) {
    const n = dayNumber(k);
    run = prev !== null && n === prev + 1 ? run + 1 : 1;
    if (run > best) best = run;
    prev = n;
  }
  return best;
}

/**
 * 从消息列表里抠出徽章要用的统计。
 * @param {Array<object>} messages 消息视图（带 createdAt / image / type）
 */
export function statsFromMessages(messages = []) {
  const days = new Set();
  let night = 0;
  let images = 0;
  let count = 0;
  for (const m of messages) {
    if (!m || m.pending || m.recalled) continue;
    count += 1;
    const at = Number(m.createdAt || m.at) || 0;
    if (at) {
      days.add(dayKey(at));
      const h = new Date(at).getHours();
      if (h >= 23 || h < 6) night += 1;
    }
    if (m.image || m.type === 'image') images += 1;
  }
  return {
    messageCount: count,
    nightCount: night,
    imageCount: images,
    chatDays: days.size,
    maxChatStreak: maxRun(days),
  };
}

/**
 * 把 ctx 补全成一份扁平统计。缺什么补什么：给了就用，没给就读库。
 * ctx 可给：`{ messages, letters, bond, checkin, stats, now }`（stats 直接给就算数，不再覆盖）
 */
export async function resolveStats(ctx = {}) {
  const now = Number(ctx.now) || Date.now();
  const stats = { now, messageCount: 0, nightCount: 0, imageCount: 0, chatDays: 0, maxChatStreak: 0, daysTogether: 0, letterCount: 0, checkinDays: 0, checkinBest: 0, bondStage: 'acquainted', bondPoints: 0 };

  if (ctx.stats && typeof ctx.stats === 'object') return { ...stats, ...ctx.stats, now };

  if (Array.isArray(ctx.messages)) {
    Object.assign(stats, statsFromMessages(ctx.messages));
  } else if (ctx.messages === undefined) {
    try {
      const rows = await listLatest('message', { limit: MESSAGE_SCAN });
      Object.assign(stats, statsFromMessages(rows.map((r) => ({ ...(r.value || {}), createdAt: r.at }))));
    } catch (err) {
      console.warn('[achievements] 取消息失败', err);
    }
  }

  if (Array.isArray(ctx.letters)) stats.letterCount = ctx.letters.length;
  else if (ctx.letterCount == null) {
    try {
      stats.letterCount = (await listLetters()).length;
    } catch (err) {
      console.warn('[achievements] 取信失败', err);
    }
  } else stats.letterCount = ctx.letterCount;

  const bond = ctx.bond || (await bondSnapshot().catch(() => null));
  if (bond) {
    stats.bondStage = bond.stage || 'acquainted';
    stats.bondPoints = Number(bond.points) || 0;
  }

  const check = ctx.checkin || (await readCheckin().catch(() => null));
  if (check) {
    stats.checkinDays = Number(check.days) || 0;
    stats.checkinBest = Number(check.best) || 0;
    if (!stats.maxChatStreak) stats.maxChatStreak = Number(check.streak) || 0;
  }

  if (typeof ctx.daysTogether === 'number') stats.daysTogether = ctx.daysTogether;
  else stats.daysTogether = stats.chatDays;

  return stats;
}

/**
 * 12 枚首批徽章。`atLeast` 是档位下标（信赖 2 / 亲近 3 / 恋人 4）。
 * 文案与 strings.zh.js 的 `ach.*` 对齐，id 就是那套键的后半段。
 */
export const LIST = [
  {
    id: 'first-chat',
    title: '第一次说话',
    hint: '发出第一条消息',
    check: (s) => s.messageCount >= 1,
  },
  {
    id: 'streak-10',
    title: '连聊十天',
    hint: '连续十天都聊过',
    check: (s) => s.maxChatStreak >= 10,
  },
  {
    id: 'day-100',
    title: '第一百天',
    hint: '一起过到第一百天',
    check: (s) => Math.max(s.daysTogether, s.maxChatStreak) >= 100,
  },
  {
    id: 'first-letter',
    title: '第一封信',
    hint: '收到她写的第一封信',
    check: (s) => s.letterCount >= 1,
  },
  {
    id: 'letter-5',
    title: '五封信',
    hint: '收满五封',
    check: (s) => s.letterCount >= 5,
  },
  {
    id: 'stage-trusted',
    title: '信赖',
    hint: '关系升到「信赖」',
    check: (s) => stageIndexOf(s.bondStage) >= 2,
  },
  {
    id: 'stage-close',
    title: '亲近',
    hint: '关系升到「亲近」',
    check: (s) => stageIndexOf(s.bondStage) >= 3,
  },
  {
    id: 'stage-lover',
    title: '恋人',
    hint: '关系升到「恋人」',
    check: (s) => stageIndexOf(s.bondStage) >= 4,
  },
  {
    id: 'first-checkin',
    title: '第一次签到',
    hint: '点一次「今天也来了」',
    check: (s) => s.checkinDays >= 1,
  },
  {
    id: 'checkin-7',
    title: '连签七天',
    hint: '连续七天都来签到',
    check: (s) => s.checkinBest >= 7 || s.maxChatStreak >= 7,
  },
  {
    id: 'first-image',
    title: '第一张图',
    hint: '存下第一张图',
    check: (s) => s.imageCount >= 1,
  },
  {
    id: 'night-chat',
    title: '深夜还在',
    hint: '在 23 点以后聊过一次',
    check: (s) => s.nightCount >= 1,
  },
];

/** 契约名。 */
export const DEFS = LIST;

const listeners = new Set();

/** 注册解锁回调（界面用来弹一次提示，弹完自己取消）。 */
export function onUnlock(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(event) {
  for (const fn of [...listeners]) {
    try {
      fn(event);
    } catch (err) {
      console.warn('[achievements] 解锁回调出错', err);
    }
  }
}

async function readUnlocked() {
  const raw = await getMeta(META_KEY, null);
  return (raw && raw.unlocked && typeof raw.unlocked === 'object') ? { ...raw.unlocked } : {};
}

/**
 * 解锁一枚（幂等：已解锁返回 false，不覆盖原时间）。
 * @param {string} id
 * @param {number} [at]
 * @returns {Promise<boolean>} 这次是否真的新解锁
 */
export async function unlock(id, at = Date.now()) {
  if (!LIST.some((d) => d.id === id)) return false;
  const unlocked = await readUnlocked();
  if (unlocked[id]) return false;
  unlocked[id] = at;
  await putMeta(META_KEY, { unlocked, updatedAt: at });
  emit({ id, at });
  return true;
}

/**
 * 全部徽章 + 解锁时间。
 * @returns {Promise<Array<{id,title,hint,unlockedAt:number}>>}
 */
export async function list() {
  const unlocked = await readUnlocked();
  return LIST.map((d) => ({
    id: d.id,
    title: d.title,
    hint: d.hint,
    unlockedAt: Number(unlocked[d.id]) || 0,
  }));
}

/** 进度条要的数：已解锁几枚、还差哪几枚、最近解锁的是哪几枚。 */
export async function progress() {
  const all = await list();
  const done = all.filter((a) => a.unlockedAt > 0);
  const recent = [...done].sort((a, b) => b.unlockedAt - a.unlockedAt).slice(0, 3);
  return {
    total: all.length,
    unlocked: done.length,
    percent: all.length ? done.length / all.length : 0,
    remaining: all.filter((a) => !a.unlockedAt).map((a) => ({ id: a.id, title: a.title, hint: a.hint })),
    recent,
  };
}

/**
 * 跑一遍全部判据，返回这次新解锁的 id（顺带落库）。
 * @param {object} [ctx] 见 resolveStats；不传就自己读库
 * @returns {Promise<string[]>}
 */
export async function checkAll(ctx = {}) {
  const stats = await resolveStats(ctx);
  const fresh = [];
  for (const def of LIST) {
    let hit = false;
    try {
      hit = !!def.check(stats);
    } catch (err) {
      // 单条判据写坏了不能连带整轮解锁失败
      console.warn(`[achievements] 判据 ${def.id} 出错`, err);
    }
    if (!hit) continue;
    if (await unlock(def.id, stats.now)) fresh.push(def.id);
  }
  return fresh;
}

/** 契约名。 */
export const evaluate = checkAll;
