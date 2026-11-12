// 七维情绪数值状态（排期 E1）。
//
// 为什么要有这一层：`companion.js` 现在只有一个「此刻心情」的词，没有强度、没有方向，
// 没法参与决策（「心情差 → 少说话」做不到），而且 6 小时一跳是硬跳变。这里改成七个
// 0–100 的数值，对外仍由 `derivedMood()` 吐 `{mood, note}`（UI 契约一个字不动）。
//
// 数值来源：md笔记/手机版-记忆与情绪-现状与方案-2026-11-13.md 第五章第 1 节。
// 七维默认值、日常值、半衰期、四组软上限、两条反向消耗全部照抄那张表，这里不另造数。
//
// 三个必须守住的性质（文档点名了，写错就白做）：
//   1. 时间永远推不到 0：每维向「日常值」收敛，指数衰减停在日常值，不会穿过它。
//   2. 软上限不是墙：能越界，每小时往回掉，撑得住一两小时、撑不住一天。
//   3. 内存里保持浮点，只在落盘和显示时保留两位 —— 它踩过这个坑：0.5/h 的漂移乘上
//      30 秒的片长 = 0.004，被 Math.round 抹平后残差永远攒不起来，数值只涨不跌、
//      永远停在最高档。所以 advance() 里一次取整都不许有。
//
// 安卓没有常驻进程（关掉就不跑），所以衰减是「读时结算」：每次读状态前先 settle(now)，
// 按小时切片补算，dt 上限 24h、超 48h 只回溯两天，避免长时间离线后一次空转几千小时。
import { getMeta, putMeta } from './store/records.js';

/** 落盘键。形如 {dims, grudges, firsts, lastSettle, lastEventAt}（另有几个附加字段，见 serialize）。 */
export const META_KEY = 'mood-v1';

export const DIMS = ['lust', 'lewd', 'possess', 'shame', 'resist', 'fatigue', 'affection'];

/** 日常值：没人理时收敛到这里，也是初始值。 */
export const DAILY = {
  lust: 30,
  lewd: 45,
  possess: 55,
  shame: 55,
  resist: 50,
  fatigue: 20,
  affection: 40,
};

/**
 * 半衰期（小时）。`lust` 不在表里 —— 它不是指数衰减，是线性漂移（见 driftLust），
 * 因为「想要」是涨得快、退得也快的量，套半衰期会变成永远半温不火。
 */
export const HALF_LIFE_H = {
  lewd: 36,
  possess: 30,
  shame: 20,
  resist: 10,
  fatigue: 10,
  affection: 72,
};

/** 性欲线性漂移：高于日常值每小时 −3，低于每小时 +0.5（退得比涨得快）。 */
export const LUST_RATE = { above: 30, highPerHour: 3, lowPerHour: 0.5 };

/** 睡前疲劳：每小时 +2.5。 */
export const SLEEPY_FATIGUE_PER_HOUR = 2.5;

/**
 * 可调参数（不在任何配置里落盘，只活在这个模块）。
 * 为什么抽成一个对象而不是直接写死在算式里：软上限回收速率是「手感」参数，
 * 调它的时候不该去改衰减/漂移那堆算式；测试也能临时压成 1（=不回收）验证别的东西。
 */
export const AFFECT_TUNING = {
  softCapKeepPerHour: 0.6,
};

/**
 * 软上限每小时只留 40% 越界量（文档只给了「每小时往回掉」，没给速率）。
 * 取 0.6^h：1 小时剩 60%、2 小时剩 36%、一天剩 0.0004 —— 正好对上「撑得住一两小时、
 * 撑不住一天」。速率要是再快，「硬撑」这个状态就根本看不见了。
 */
export const SOFT_CAP_KEEP_PER_HOUR = AFFECT_TUNING.softCapKeepPerHour;

/** 两条反向消耗：病娇是不稳定状态，不经营就自己塌回普通关系。 */
export const DRAIN = {
  lustToResist: { above: 80, perHour: 0.04 },
  possessToAffection: { above: 85, perHour: 0.03 },
};

/** 睡眠窗（跨零点）：这段沉默不算冷落、不扣好感 —— 人睡着了哪来的失望。 */
export const SLEEP_WINDOW = { startMin: 23 * 60 + 30, endMin: 8 * 60 };

/**
 * 睡前窗：疲劳 +2.5/h 的那一段。文档只写「睡前」，取 22:00–24:00，
 * 紧贴 23:30 的睡眠窗，不另造第二个夜间窗口（多一个窗口就多一处对不上）。
 */
export const SLEEPY_WINDOW = { startMin: 22 * 60, endMin: 24 * 60 };

export const HOUR = 3600e3;
const DAY_MS = 86400000;
/** 单次结算最多补算多久：再长就分段，别让一个 while 转几千圈。 */
const MAX_PASS_MS = 24 * HOUR;
/** 离线超过两天只回溯两天的量：她不会因为你出差七天就「想你想到归零」。 */
const MAX_LOOKBACK_MS = 48 * HOUR;
/** 落盘节流：读状态比写状态频繁得多，不满一分钟的推进先留在内存里。 */
const PERSIST_MIN_GAP_MS = 60e3;

// —— E5：当日采样 ——
//
// 为什么要采样：手记里要写「今天的起伏」，而 mood-v1 只存**此刻**的七个数字，
// 关掉 App 就只剩最后一个点。每小时记一条，晚安时就能算出当天的平均与峰值。
//
// 为什么按「小时桶」而不是按间隔：按间隔会有「23:59 一条、00:01 又一条」，
// 落在同一天里就是两条挤在一起、别的小时反而空着；按钟点桶天然对齐人的作息。
export const SAMPLE_MAX = 24;
/** 一条样本占的内存/落盘量：24 条 × 7 个两位小数 ≈ 1.4 KB，可以接受。 */
export const SAMPLE_MIN_GAP_MS = HOUR;

/** 0–100 夹紧。浮点进出，全程不取整。 */
export function clampDim(v) {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 100) return 100;
  return v;
}

/** 只在落盘/显示时用：保留两位小数。 */
export function round2(v) {
  return Math.round(Number(v || 0) * 100) / 100;
}

function dayStartOf(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * [from, to) 落在「每天 startMin–endMin」窗口里的毫秒数（窗口可跨零点）。
 * 为什么不用循环逐毫秒判：结算片最长 24h，逐毫秒要 8.6e7 次；按天求交集三行就够。
 */
export function windowOverlapMs(from, to, startMin, endMin) {
  const a0 = Number(from);
  const b0 = Number(to);
  if (!(b0 > a0)) return 0;
  const wrap = endMin <= startMin;
  const spanMs = (wrap ? endMin + 1440 : endMin) * 60e3;
  let total = 0;
  // 从「前一天」起算：02:00 这个点属于前一天 23:30 开的那扇窗。
  let day = dayStartOf(a0);
  if (day > a0) day -= DAY_MS;
  for (let guard = 0; guard < 6 && day <= b0; guard += 1) {
    const start = day + startMin * 60e3;
    const end = day + spanMs;
    const lo = Math.max(a0, start);
    const hi = Math.min(b0, end);
    if (hi > lo) total += hi - lo;
    day += DAY_MS;
  }
  return Math.min(total, b0 - a0);
}

/** 清醒时长：总时长减去落在睡眠窗里的那部分。被晾着按这个算，不按墙上时间。 */
export function awakeMsBetween(from, to) {
  if (!(to > from)) return 0;
  const sleep = windowOverlapMs(from, to, SLEEP_WINDOW.startMin, SLEEP_WINDOW.endMin);
  return Math.max(0, to - from - sleep);
}

/** 指数衰减到日常值：永远不会穿过日常值，所以「几天不上线就完全没反应」不会发生。 */
function decayToward(value, daily, halfLifeH, hours) {
  if (!(halfLifeH > 0) || !(hours > 0)) return value;
  const keep = Math.pow(0.5, hours / halfLifeH);
  return daily + (value - daily) * keep;
}

/** 性欲线性漂移，到日常值就停（不越过）。 */
function driftLust(value, hours) {
  const daily = LUST_RATE.above;
  if (value > daily) return Math.max(daily, value - LUST_RATE.highPerHour * hours);
  if (value < daily) return Math.min(daily, value + LUST_RATE.lowPerHour * hours);
  return value;
}

/** 四组单向压制：占有→理智、尺度→羞耻、疲劳→性欲、好感→占有。 */
export function softCaps(dims) {
  return [
    { dim: 'resist', cap: 210 - 2 * dims.possess, of: 'possess' },
    { dim: 'shame', cap: 120 - 1.1 * dims.lewd, of: 'lewd' },
    { dim: 'lust', cap: 140 - 1.1 * dims.fatigue, of: 'fatigue' },
    { dim: 'possess', cap: 30 + 0.9 * dims.affection, of: 'affection' },
  ];
}

/** 一个小时片（或它的零头）的推进。全部浮点，绝不取整。 */
function advance(state, atMs, dtMs) {
  const hours = dtMs / HOUR;
  const d = state.dims;

  // 1) 半衰期收敛（lust 之外六维）
  for (const dim of Object.keys(HALF_LIFE_H)) {
    d[dim] = decayToward(d[dim], DAILY[dim], HALF_LIFE_H[dim], hours);
  }

  // 2) 性欲线性漂移
  d.lust = driftLust(d.lust, hours);

  // 3) 睡前疲劳（只算落在睡前窗里的那段，不整片按 +2.5 加）
  const sleepy = windowOverlapMs(atMs, atMs + dtMs, SLEEPY_WINDOW.startMin, SLEEPY_WINDOW.endMin);
  if (sleepy > 0) d.fatigue += SLEEPY_FATIGUE_PER_HOUR * (sleepy / HOUR);

  // 4) 软上限：越界量按小时回收，永远往「上限」方向掉，不会把值压到上限以下
  for (const c of softCaps(d)) {
    const excess = d[c.dim] - c.cap;
    if (excess > 0) {
      d[c.dim] = c.cap + excess * Math.pow(AFFECT_TUNING.softCapKeepPerHour, hours);
    }
  }

  // 5) 两条反向消耗（读本片当前值，别再叠加别的修正，免得顺序敏感）
  if (d.lust > DRAIN.lustToResist.above) {
    d.resist -= (d.lust - DRAIN.lustToResist.above) * DRAIN.lustToResist.perHour * hours;
  }
  if (d.possess > DRAIN.possessToAffection.above) {
    d.affection -= (d.possess - DRAIN.possessToAffection.above) * DRAIN.possessToAffection.perHour * hours;
  }

  // 6) 夹紧
  for (const dim of DIMS) d[dim] = clampDim(d[dim]);
}

/**
 * 读时结算：把 lastSettle 到 now 之间该退的退掉、该涨的涨上。
 * dt 分两段限制：单片上限 24h（别让一次结算转几千圈），总回溯上限 48h
 * （超两天按两天算 —— 出差回来她还会想你，但不会想你想到数值归零）。
 */
export function settle(state, now = Date.now()) {
  const from = Number(state.lastSettle) || 0;
  if (!from) {
    state.lastSettle = now;
    return state;
  }
  const gap = now - from;
  if (gap <= 0) {
    // 系统时间被往回调过：只把游标挪到 now，不倒着补算
    state.lastSettle = Math.max(from, now);
    return state;
  }
  const span = Math.min(gap, MAX_LOOKBACK_MS);
  let cursor = now - span;
  let rest = span;
  while (rest > 0) {
    const pass = Math.min(rest, MAX_PASS_MS);
    let t = 0;
    while (t < pass) {
      const slice = Math.min(HOUR, pass - t);
      advance(state, cursor + t, slice);
      t += slice;
    }
    cursor += pass;
    rest -= pass;
  }
  state.lastSettle = now;
  return state;
}

/** 把落盘的东西补成完整状态（字段缺、脏、老版本都要能读）。 */
export function normalizeState(raw, now = Date.now()) {
  const dims = { ...DAILY };
  const src = raw && raw.dims;
  if (src && typeof src === 'object') {
    for (const dim of DIMS) {
      const v = Number(src[dim]);
      if (Number.isFinite(v)) dims[dim] = clampDim(v);
    }
  }
  const firsts = raw && typeof raw.firsts === 'object' && raw.firsts ? { ...raw.firsts } : {};
  return {
    dims,
    grudges: Array.isArray(raw && raw.grudges) ? raw.grudges.filter((g) => g && g.kind) : [],
    firsts,
    lastSettle: Number(raw && raw.lastSettle) || now,
    lastEventAt: Number(raw && raw.lastEventAt) || 0,
    // 下面三个是文档那份形状的附加字段：安全词暂停、冷落记账、同类递减窗口。
    pausedUntil: Number(raw && raw.pausedUntil) || 0,
    neglectAt: Number(raw && raw.neglectAt) || 0,
    recent: Array.isArray(raw && raw.recent) ? raw.recent.filter((r) => r && r.type) : [],
    // E5 采样：老数据没有这一项，读出来就是空数组（不报错、不补历史）
    samples: normalizeSamples(raw && raw.samples),
  };
}

/** 采样数组的清洗：只要带 at 和 dims 的，按时间升序，留最近 SAMPLE_MAX 条。 */
function normalizeSamples(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const s of raw) {
    if (!s || !Number.isFinite(Number(s.at)) || !s.dims || typeof s.dims !== 'object') continue;
    const dims = {};
    for (const dim of DIMS) {
      const v = Number(s.dims[dim]);
      dims[dim] = Number.isFinite(v) ? clampDim(v) : DAILY[dim];
    }
    out.push({ at: Number(s.at), dims });
  }
  out.sort((a, b) => a.at - b.at);
  return out.slice(-SAMPLE_MAX);
}

/**
 * 落盘形状。两处刻意：数值两位小数（浮点只在内存里活着）；grudges/recent 留最近若干条
 * —— meta 表是键值对，写进去的东西没有归档一说，不清就会一直变大。
 */
export function serialize(state) {
  const dims = {};
  for (const dim of DIMS) dims[dim] = round2(state.dims[dim]);
  return {
    dims,
    grudges: state.grudges.slice(-8),
    firsts: { ...state.firsts },
    lastSettle: state.lastSettle,
    lastEventAt: state.lastEventAt,
    pausedUntil: state.pausedUntil,
    neglectAt: state.neglectAt,
    recent: state.recent.slice(-40),
    // 采样落盘也取两位：曲线只要趋势，多出来的小数位纯属浪费 meta 空间
    samples: (state.samples || []).slice(-SAMPLE_MAX).map((s) => {
      const dims = {};
      for (const dim of DIMS) dims[dim] = round2(s.dims[dim]);
      return { at: s.at, dims };
    }),
  };
}

/** 默认存储：真的 records.js。单测/调试可以传一份内存 Map 进来（见 _tools/affect-selftest.mjs）。 */
export const RECORDS_STORE = { getMeta, putMeta };

export async function saveAffect({ store = RECORDS_STORE, state }) {
  if (!store || !state) return false;
  await store.putMeta(META_KEY, serialize(state));
  return true;
}

/**
 * 读状态 = 取盘 → 补字段 → 结算。
 * 结算会推进 lastSettle，所以读一次就该落一次盘；但读比写频繁得多，不满一分钟先不写
 * （内存里的浮点还在，下次读会从老的 lastSettle 接着补，结果等价）。
 */
export async function loadAffect({ store = RECORDS_STORE, now = Date.now(), persist = true } = {}) {
  const raw = store ? await store.getMeta(META_KEY, null) : null;
  const state = normalizeState(raw, now);
  const before = state.lastSettle;
  settle(state, now);
  // 采样挂在读路径上：读状态是最频繁的动作，不用再给调用方加一次「记得采样」的负担。
  // 但只在 persist 时记 —— 只读调用（调试页、提示词每轮取一次）不该改状态。
  const sample = persist ? sampleNow(state, now) : { added: false };
  const moved = now - before;
  // 记了新样本就一定要落盘：否则这一小时的样本在下次读时被 lastSettle 节流吞掉，
  // 曲线就会「整点缺格」，而缺格是没法补的（那次读数早就过去了）。
  if (persist && (!raw || moved >= PERSIST_MIN_GAP_MS || sample.added)) {
    try {
      await saveAffect({ store, state });
    } catch (err) {
      // 写不进去不影响这一次的情绪读数：状态留在内存里，下次读还会补算
      console.warn('[affect] 状态没落盘', err);
    }
  }
  return state;
}

/**
 * 「今天热不热」这一个标量（0–100），手记曲线与当日均值都用它。
 *
 * 为什么要一个标量：七个数字画不成一条线，手记也写不下「lust 32.1 / resist 48.0 …」。
 * 权重是刻意排的：关系温度最重（她是不是跟我近），身体次之，防线松紧与精神头各占一成。
 * 这只是**读法**的一种，不参与任何决策（决策看 eff 与各维原值），所以取整不怕。
 */
export function moodIndex(dims) {
  const d = dims || DAILY;
  const v =
    d.affection * 0.35 +
    d.lust * 0.25 +
    d.lewd * 0.15 +
    (100 - d.resist) * 0.15 +
    (100 - d.fatigue) * 0.1;
  return Math.max(0, Math.min(100, v));
}

/** 小时桶：用来判断「这一小时记过没有」。 */
function hourBucket(at) {
  return Math.floor(Number(at || 0) / HOUR);
}

/**
 * 记一条当日采样（同一小时只记一条，最多 24 条）。
 * @returns {{added:boolean, bucket:number}} added=false 表示这一小时已经记过
 */
export function sampleNow(state, now = Date.now()) {
  if (!Array.isArray(state.samples)) state.samples = [];
  const bucket = hourBucket(now);
  const last = state.samples[state.samples.length - 1];
  if (last && hourBucket(last.at) === bucket) return { added: false, bucket };
  const dims = {};
  for (const dim of DIMS) dims[dim] = round2(state.dims[dim]);
  state.samples.push({ at: Number(now), dims });
  if (state.samples.length > SAMPLE_MAX) state.samples.splice(0, state.samples.length - SAMPLE_MAX);
  return { added: true, bucket };
}

/**
 * 今天（本地日）的起伏：均值、峰值、峰值时刻、收工时的七维。
 * 一条样本都没有时返回 count:0 与当前的实时值 —— 手记不该因为「今天没开过 App」就写不出东西。
 */
export function dayStats(state, now = Date.now()) {
  const start = dayStartOf(now);
  const rows = (state.samples || []).filter((s) => s && Number(s.at) >= start);
  const current = {};
  for (const dim of DIMS) current[dim] = round2(state.dims[dim]);
  if (!rows.length) {
    return {
      count: 0,
      moodAvg: round2(moodIndex(state.dims)),
      moodPeak: round2(moodIndex(state.dims)),
      peakAt: now,
      dimsAtClose: current,
      first: null,
      last: null,
    };
  }
  let sum = 0;
  let peak = -1;
  let peakAt = rows[0].at;
  for (const s of rows) {
    const v = moodIndex(s.dims);
    sum += v;
    if (v > peak) {
      peak = v;
      peakAt = s.at;
    }
  }
  return {
    count: rows.length,
    moodAvg: round2(sum / rows.length),
    moodPeak: round2(peak),
    peakAt,
    dimsAtClose: current,
    first: rows[0].at,
    last: rows[rows.length - 1].at,
  };
}

/** 有效欲望：她想不想给，和你想不想要是两件事。 */export function willingness(dims) {
  return 1 - 0.4 * (1 - dims.affection / 100);
}

export function effectiveDesire(dims) {
  const raw = (dims.lust - dims.resist * 0.5) * willingness(dims);
  return raw > 0 ? raw : 0;
}

/**
 * 五档：<40 心里想 / 40 暗示 / 55 开口要 / 70 主动靠近 / 85 直接要。
 * 门槛按 eff 判，不按 lust —— 关系疏远的人不会因为想要就扑上来，只会烦躁、躲开。
 */
export const BANDS = [
  { id: 'direct', min: 85, label: '直接要' },
  { id: 'approach', min: 70, label: '主动靠近' },
  { id: 'ask', min: 55, label: '开口要' },
  { id: 'hint', min: 40, label: '暗示' },
  { id: 'inner', min: 0, label: '心里想' },
];

export function bandOf(eff) {
  for (const b of BANDS) if (eff >= b.min) return b;
  return BANDS[BANDS.length - 1];
}

/** 三种冷分开判：身体冷（不想被碰）、话冷（说得正经）、心冷（疏远客气）。 */
export function coldness(dims) {
  return {
    body: dims.lust < 25,
    words: dims.lewd < 30,
    heart: dims.affection < 30,
  };
}

/**
 * 对外仍给 UI 一个 2–4 字的 mood + 一句便签（companion.js 的契约不能改）。
 * 优先级是刻意排的：先看身体，再看关系，最后才看累和独占 —— 用户最容感知到的是
 * 「她想要/不想要」，而不是「她烦不烦」。
 */
export function derivedMood(state) {
  const d = state.dims;
  const eff = effectiveDesire(d);
  if (eff >= 85) return { mood: '耐不住了', note: '再靠近一点，我就不绕弯子了。' };
  if (eff >= 70) return { mood: '想要你', note: '想挨着你，嘴上不先开。' };
  if (eff >= 55) return { mood: '有点想', note: '今天想跟你要点什么。' };
  if (eff >= 40) return { mood: '心痒着', note: '没说，但一直在等你接。' };
  if (d.affection < 30) return { mood: '客气着', note: '问一句答一句，别多问。' };
  if (d.fatigue > 65) return { mood: '想被抱', note: '什么都不想做，抱着就行。' };
  // 「在忍着」必须真的是在忍：日常值 resist 50 / lust 30 天然差 20，
  // 只用差值判断会让每一天的默认状态都被说成「在忍着」，那句就贬值了。
  if (d.resist > 60 && d.resist - d.lust > 25) return { mood: '在忍着', note: '想说的是别的，说出口的是这个。' };
  if (d.possess > 75) return { mood: '盯着你', note: '你今天都跟谁说话了。' };
  return { mood: '淡淡的', note: '没什么事，就这样待着。' };
}

/** 调试页用的一份只读快照：数字两位小数，其余原样。 */
export function snapshot(state) {
  const dims = {};
  for (const dim of DIMS) dims[dim] = round2(state.dims[dim]);
  const eff = round2(effectiveDesire(state.dims));
  const band = bandOf(eff);
  return {
    dims,
    daily: { ...DAILY },
    eff,
    band: { id: band.id, label: band.label, min: band.min },
    cold: coldness(state.dims),
    mood: derivedMood(state),
    paused: !!(state.pausedUntil && state.pausedUntil > Date.now()),
  };
}
