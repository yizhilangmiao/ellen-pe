// 签到：记录「今天也来过」，顺手给亲密度加点；断签不惩罚，连续天数只用来发奖励与解锁徽章。
//
// 为什么不用聊天记录推「今天来过」：她可能一整天只打开相处页看一眼、一句话没说。
// 签到是唯一一个「他主动露过面」的显式动作，值得单独记。
import { getMeta, putMeta } from './store/records.js';
import { listLatest } from './store/library.js';
import { addPoints, dayKey } from './bond.js';

export const META_KEY = 'checkin-v1';

/** 每天签到的基础加点。 */
export const CHECKIN_POINTS = 5;
/** 连满 7 天额外加多少（每满 7 天都给一次，不是只给第一次）。 */
export const STREAK_BONUS = 20;
export const STREAK_BONUS_EVERY = 7;

/** 一条手记/记忆都没有时的兜底句子（按日期轮换，不会连着两天一样）。 */
const FALLBACK_LINES = [
  '今天也来了，就当是陪我坐了一会儿。',
  '不用说什么，你在就够了。',
  '今天想先听你说一句：早饭吃了没。',
  '我把椅子挪过来了，你坐这边。',
  '今天天气怎么样？我这边看不见。',
  '要不今天少想点事，早点睡。',
  '你来的时间比昨天早一点。',
  '我没别的意思，就是想看看你在不在。',
];

export function defaultState() {
  return { days: 0, streak: 0, best: 0, lastDay: '' };
}

export function normalizeState(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== 'object') return base;
  return {
    days: Math.max(0, Number(raw.days) || 0),
    streak: Math.max(0, Number(raw.streak) || 0),
    best: Math.max(0, Number(raw.best) || 0),
    lastDay: typeof raw.lastDay === 'string' ? raw.lastDay : '',
  };
}

/** 今天（本地日）。跨零点按设备本地时间算，不按 UTC。 */
export function todayKey(now = Date.now()) {
  return dayKey(now);
}

/** 昨天（本地日）。用 setDate 而不是减 86400000：夏令时那天少一小时会算错。 */
export function yesterdayKey(now = Date.now()) {
  const d = new Date(now);
  d.setDate(d.getDate() - 1);
  return dayKey(d.getTime());
}

/** 读签到状态（没有就返回全零的默认值，不写库）。 */
export async function readCheckin() {
  return normalizeState(await getMeta(META_KEY, null));
}

/**
 * 连续天数信息。
 * @param {object} [state] 不传就按「已读到的 state」算（传的是 state 对象，不是 promise）
 * @returns {{days:number, streak:number, best:number, lastDay:string, checkedToday:boolean, alive:boolean, bonusEvery:number, daysToBonus:number}}
 */
export function streakInfo(state) {
  const s = normalizeState(state);
  const today = todayKey();
  const checkedToday = s.lastDay === today;
  // 昨天签过 = 这串还没断（今天签下去就 +1）；前天或更早签的 = 已经断了
  const alive = checkedToday || s.lastDay === yesterdayKey();
  const streak = alive ? s.streak : 0;
  const mod = streak % STREAK_BONUS_EVERY;
  return {
    days: s.days,
    streak,
    best: s.best,
    lastDay: s.lastDay,
    checkedToday,
    alive,
    bonusEvery: STREAK_BONUS_EVERY,
    daysToBonus: mod === 0 ? STREAK_BONUS_EVERY : STREAK_BONUS_EVERY - mod,
  };
}

/** 取一句话：优先最近的手记/记忆（有内容才像她说的），实在没有就用兜底句。 */
async function linePool() {
  const out = [];
  try {
    const journals = await listLatest('journal', { limit: 8 });
    for (const r of journals) {
      const v = r.value || {};
      const t = String(v.diary || v.title || '').trim();
      const one = firstSentence(t);
      if (one) out.push(one);
    }
  } catch (err) {
    console.warn('[checkin] 取手记失败', err);
  }
  if (!out.length) {
    try {
      // memory 是主动消息的素材来源（proactive.pushMaterial 读的就是它），
      // 这里只读不消费：takePending 会把 native 的单槽清空，签到不该顺手吃掉一条待发消息。
      const mems = await listLatest('memory', { limit: 8 });
      for (const r of mems) {
        const v = r.value || {};
        const one = firstSentence(String(v.title || v.summary || v.body || ''));
        if (one) out.push(one);
      }
    } catch (err) {
      console.warn('[checkin] 取记忆失败', err);
    }
  }
  return out.length ? out : FALLBACK_LINES;
}

function firstSentence(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const m = t.match(/^[^。！？!?]{4,40}[。！？!?]?/);
  return m ? m[0].trim() : t.slice(0, 40);
}

/**
 * 「今天的一句话」。同一天永远同一句（日期取模），相邻两天不会重复。
 * @param {number} [now]
 * @returns {Promise<string>}
 */
export async function dailyLine(now = Date.now()) {
  const pool = await linePool();
  const day = Math.floor(now / 86400000);
  return pool[day % pool.length];
}

/**
 * 签到。今天已经签过就什么都不改，只回现状（幂等，按钮连点也不会多加点）。
 * @param {number} [now]
 * @returns {Promise<{first:boolean, state:object, gained:number, bonus:number, streak:number, best:number, bond:object|null, line:string}>}
 */
export async function doCheckin(now = Date.now()) {
  const prev = await readCheckin();
  const day = todayKey(now);
  const line = await dailyLine(now);

  if (prev.lastDay === day) {
    const info = streakInfo(prev);
    return { first: false, state: prev, gained: 0, bonus: 0, streak: info.streak, best: info.best, bond: null, line };
  }

  const alive = prev.lastDay === yesterdayKey(now);
  const streak = alive ? prev.streak + 1 : 1;
  const next = {
    days: prev.days + 1,
    streak,
    best: Math.max(prev.best, streak),
    lastDay: day,
  };
  await putMeta(META_KEY, next);

  const bonus = streak % STREAK_BONUS_EVERY === 0 ? STREAK_BONUS : 0;
  const gained = CHECKIN_POINTS + bonus;

  let bond = null;
  try {
    // 加点失败不能让签到本身失败（点数可以下次补，日期错过就补不回来了）
    bond = await addPoints(gained, { at: now, reason: 'checkin' });
  } catch (err) {
    console.warn('[checkin] 加成失败', err);
  }

  return { first: true, state: next, gained, bonus, streak, best: next.best, bond, line };
}

// —— 契约里的名字（照抄一份别名，调用方用哪套都行） ——
/** 契约名：读签到状态。 */
export const read = readCheckin;
/** 契约名：签到。 */
export const checkIn = doCheckin;
/** 契约名：给一份状态算连续天数。 */
export const streakOf = (state) => streakInfo(state).streak;
