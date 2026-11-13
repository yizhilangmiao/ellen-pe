// 亲密度：把「聊了多少」折成一条能画在相处页上的关系进度，只管规则，不发信也不碰界面。
//
// 为什么规则单独成文件：阈值、档位名、落款、口吻都是「设定」。改设定不该动界面，
// 改界面也不该动设定；而且改阈值时历史聊天记录一条都不用动，只要重算一次档位。
// 全部状态落在 meta `bond-v1` 一个键里，旧键留着就能回滚。
//
// 档位 / 阈值 / 落款 / 口吻照《手机版-补齐-接口契约-2026-11-12.md》§4（电脑版 bond.cjs POLICY bond-v1）。
import { getMeta, putMeta } from './store/records.js';

/** 策略版本。写进 meta 键名，将来换规则就开 v2，v1 原地留着当历史。 */
export const POLICY_VERSION = 'bond-v1';
export const META_KEY = POLICY_VERSION;

/**
 * 五个档位。threshold 是「**离开**这一档要多少点」——
 * 契约表里那串 `25 / 80 / 165 / 390 / ∞` 只能这么读：认识→熟悉 25，熟悉→信赖 80，
 * 信赖→亲近 165，亲近→恋人 390，恋人没有下一档所以是 Infinity。
 * 反过来的读法（相识要 25 点）会让「刚装好还没聊天」落不到任何一档，档位条没得画。
 */
export const STAGES = [
  {
    id: 'acquainted',
    label: '相识',
    threshold: 25,
    minChars: 1500,
    sign: '——你的朋友艾莲',
    temper: '还不太熟，说话带点客气，会小心试探他的反应，不越界。',
  },
  {
    id: 'familiar',
    label: '熟悉',
    threshold: 80,
    minChars: 1500,
    sign: '——你的好朋友艾莲',
    temper: '已经熟了，会主动讲自己的事，也敢拿他打趣。',
  },
  {
    id: 'trusted',
    label: '信赖',
    threshold: 165,
    minChars: 1500,
    sign: '——艾莲',
    temper: '放得下心来，会说一些平时不跟别人说的话。',
  },
  {
    id: 'close',
    label: '亲近',
    threshold: 390,
    minChars: 1500,
    sign: '——你的、就差一句话的艾莲',
    temper: '黏他、会撒娇，也会流露出怕失去他的意思。',
  },
  {
    id: 'lover',
    label: '恋人',
    threshold: Infinity,
    minChars: 3000,
    sign: '——你的恋人——爱你的鲨鱼',
    temper: '已经是恋人了，说话不遮掩，会直白地说想他、爱他。',
  },
];

/** 防跳级：想升到下一档，本阶段至少先攒够这么多条消息（一天刷 400 条也升不上去）。 */
export const MIN_STAGE_MESSAGES = 30;

/** 每条消息 +1；当天第一条给 3（是「总 3」，不是 1+3——契约里额外奖励会用「额外」两个字）。 */
export const POINTS_PER_MESSAGE = 1;
export const FIRST_OF_DAY_POINTS = 3;

/** 本地日键 `2026-11-12`。这里自己写一份而不 import journal 的：亲密度是最底层的模块，
 *  为了一行日期把整条手记链（模型调用 / 召回）拉进来不值得。
 *  @param {number} at 毫秒时间戳
 *  @returns {string}
 */
export function dayKey(at = Date.now()) {
  const d = new Date(at);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 档位 id → 下标（认不出就是 0，不让脏数据把界面搞崩）。 */
export function stageIndexOf(stageId) {
  const i = STAGES.findIndex((s) => s.id === stageId);
  return i >= 0 ? i : 0;
}

/** 某一档的**进入**点数：相识 0 / 熟悉 25 / 信赖 80 / 亲近 165 / 恋人 390。 */
export function entryThreshold(index) {
  const i = Math.max(0, Math.min(STAGES.length - 1, Number(index) || 0));
  if (i === 0) return 0;
  const prev = STAGES[i - 1].threshold;
  return Number.isFinite(prev) ? prev : 0;
}

/** 纯函数：点数 → 档位对象。档位不进化的真实门槛还得看消息数，这一步只给「按点子该到哪」。 */
export function stageOf(points) {
  const p = Number(points) || 0;
  for (let i = STAGES.length - 1; i >= 0; i--) {
    if (p >= entryThreshold(i)) return STAGES[i];
  }
  return STAGES[0];
}

/**
 * 契约名：这一档的下一档门槛。
 * 恋人档的门槛是 ∞，这里返回 `null` 而不是 Infinity —— 界面拿它算「还差多少点」时，
 * Infinity 会渲染成「还差 Infinity 点」，null 才能被 `if (to == null)` 干净地挡掉。
 */
export function nextThreshold(stageId) {
  const t = STAGES[stageIndexOf(stageId)].threshold;
  return Number.isFinite(t) ? t : null;
}

/** 默认（空库）状态。 */
export function defaultState() {
  return {
    version: POLICY_VERSION,
    enabled: true,
    points: 0,
    stage: STAGES[0].id,
    stageSince: 0,
    stageMessages: 0,
    lastDay: '',
    letters: {},
    updatedAt: 0,
  };
}

/** 把库里读到的东西补成完整形状：老包没这个键、字段缺一半、档位名写错，都在这里兜住。 */
export function normalizeState(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== 'object') return base;
  const out = { ...base, ...raw };
  out.enabled = raw.enabled !== false;
  out.points = Math.max(0, Number(raw.points) || 0);
  out.stage = STAGES.some((s) => s.id === raw.stage) ? raw.stage : stageOf(out.points).id;
  out.stageSince = Number(raw.stageSince) || 0;
  out.stageMessages = Math.max(0, Number(raw.stageMessages) || 0);
  out.lastDay = typeof raw.lastDay === 'string' ? raw.lastDay : '';
  out.letters = raw.letters && typeof raw.letters === 'object' ? { ...raw.letters } : {};
  out.updatedAt = Number(raw.updatedAt) || 0;
  return out;
}

async function readState() {
  return normalizeState(await getMeta(META_KEY, null));
}

async function writeState(state) {
  const next = { ...state, version: POLICY_VERSION, updatedAt: Number(state.updatedAt) || Date.now() };
  await putMeta(META_KEY, next);
  return next;
}

// —— 升阶事件 ——
// 只发事件不做事：发信、弹窗、播语音都在界面层接，数据层不去调别人的网络。
const listeners = new Set();

/**
 * 注册升阶回调。
 * @param {(e:{stage:string, prevStage:string, points:number})=>void} fn
 * @returns {() => void} 取消注册
 */
export function onChange(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(event) {
  for (const fn of [...listeners]) {
    try {
      fn(event);
    } catch (err) {
      // 一个监听器写坏了不能连带把升阶结果吞掉
      console.warn('[bond] 升阶回调出错', err);
    }
  }
}

/**
 * 试着往上升（可能一次升好几档）。就地改 state，返回新档位 id；没升返回 null。
 * 两个条件同时满足才升：点数够下一档 + 本阶段消息数 ≥ MIN_STAGE_MESSAGES。
 */
function advance(state, at) {
  let cur = stageIndexOf(state.stage);
  let moved = null;
  while (cur < STAGES.length - 1) {
    const need = STAGES[cur].threshold;
    if (state.points < need) break;
    if (state.stageMessages < MIN_STAGE_MESSAGES) break;
    cur += 1;
    state.stage = STAGES[cur].id;
    state.stageSince = at;
    state.stageMessages = 0;
    moved = state.stage;
  }
  return moved;
}

/** 档位进度条要的数：从哪到哪、还差多少点、卡在哪一侧。 */
export function progressOf(state) {
  const st = normalizeState(state);
  const i = stageIndexOf(st.stage);
  const from = entryThreshold(i);
  const to = STAGES[i].threshold;
  const span = to - from;
  const finite = Number.isFinite(span) && span > 0;
  const ratio = finite ? Math.min(1, Math.max(0, (st.points - from) / span)) : 1;
  return {
    stage: STAGES[i].id,
    label: STAGES[i].label,
    index: i,
    points: st.points,
    from,
    to: Number.isFinite(to) ? to : null,
    ratio,
    remaining: Number.isFinite(to) ? Math.max(0, to - st.points) : 0,
    messages: st.stageMessages,
    needMessages: MIN_STAGE_MESSAGES,
    // 点够了但条数不够，界面该说「聊得再久一点」而不是「再聊几句」
    blockedByMessages: Number.isFinite(to) && st.points >= to && st.stageMessages < MIN_STAGE_MESSAGES,
    enabled: st.enabled,
  };
}

/** 快照：界面一把拿全（含档位文案、落款、字数下限），不用自己再算。 */
export function snapshotOf(state) {
  const st = normalizeState(state);
  const i = stageIndexOf(st.stage);
  const info = STAGES[i];
  return {
    version: POLICY_VERSION,
    enabled: st.enabled,
    points: st.points,
    stage: info.id,
    stageLabel: info.label,
    stageIndex: i,
    stageSince: st.stageSince,
    stageMessages: st.stageMessages,
    lastDay: st.lastDay,
    letters: { ...st.letters },
    updatedAt: st.updatedAt,
    sign: info.sign,
    minChars: info.minChars,
    temper: info.temper,
    progress: progressOf(st),
  };
}

/** 当前快照（读库版）。 */
export async function snapshot() {
  return snapshotOf(await readState());
}

/** 当前点数。 */
export async function points() {
  return (await readState()).points;
}

/** 当前档位 id（字符串）。 */
export async function stage() {
  return (await readState()).stage;
}

/** 当前档位进度（给阶段条用）。 */
export async function progress() {
  return progressOf(await readState());
}

/** 开关是否开着。关掉后不累点、不升阶、不触发写信，但已有数据原样保留。 */
export async function isEnabled() {
  return (await readState()).enabled;
}

/** 开 / 关。关掉只影响以后，不回滚已经攒下的点数。 */
export async function setEnabled(v) {
  const st = await readState();
  st.enabled = !!v;
  st.updatedAt = Date.now();
  await writeState(st);
  return st.enabled;
}

/**
 * 聊了一句：+1（当天第一句 +3），累计本阶段消息数，然后看要不要升阶。
 * @param {{at?: number}} [opts]
 * @returns {Promise<{points:number, stage:string, upgraded:boolean, prevStage:string, delta:number, firstOfDay:boolean, letterDue:boolean}>}
 */
export async function touchMessage({ at = Date.now() } = {}) {
  const st = await readState();
  const prevStage = st.stage;
  if (!st.enabled) {
    return {
      points: st.points,
      stage: st.stage,
      upgraded: false,
      prevStage,
      delta: 0,
      firstOfDay: false,
      letterDue: !st.letters[st.stage],
    };
  }
  const firstOfDay = st.lastDay !== dayKey(at);
  const delta = firstOfDay ? FIRST_OF_DAY_POINTS : POINTS_PER_MESSAGE;
  st.points += delta;
  st.lastDay = dayKey(at);
  st.stageMessages += 1;
  const moved = advance(st, at);
  st.updatedAt = at;
  await writeState(st);
  if (moved) emit({ stage: moved, prevStage, points: st.points });
  return {
    points: st.points,
    stage: st.stage,
    upgraded: !!moved,
    prevStage,
    delta,
    firstOfDay,
    letterDue: !st.letters[st.stage],
  };
}

/**
 * 额外加点（签到 / 连续奖励 / 将来别的活动走这里）——不增加本阶段消息数。
 * @param {number} n 点数（正负都行，负数不会把总点数压到 0 以下）
 * @param {{at?: number, reason?: string}} [opts]
 */
export async function addPoints(n, { at = Date.now(), reason = '' } = {}) {
  const st = await readState();
  const prevStage = st.stage;
  const delta = Number(n) || 0;
  if (!st.enabled || !delta) {
    return { points: st.points, stage: st.stage, upgraded: false, prevStage, delta: 0, reason };
  }
  st.points = Math.max(0, st.points + delta);
  const moved = advance(st, at);
  st.updatedAt = at;
  await writeState(st);
  if (moved) emit({ stage: moved, prevStage, points: st.points });
  return { points: st.points, stage: st.stage, upgraded: !!moved, prevStage, delta, reason };
}

/** 这一档的信写过没有。没写过 = 该写（契约 `letterDue`）。 */
export async function letterDue(stageId = null) {
  const st = await readState();
  const id = stageId || st.stage;
  return !st.letters[id];
}

/** 记下「这一档已经写过信」，避免同一档反复自动写。 */
export async function markLetterWritten(stageId, at = Date.now()) {
  const st = await readState();
  const id = stageId || st.stage;
  st.letters = { ...st.letters, [id]: at };
  st.updatedAt = at;
  await writeState(st);
  return st.letters[id];
}

/**
 * 用现成的消息列表补一次档位判定（冷启动/导入后调一次就够，不必逐条 touch）。
 * 只补「本阶段消息数」，不重复加点。
 * @param {{messages?: Array<{createdAt?:number,pending?:boolean}>, at?: number}} [opts]
 */
export async function maybeLevelUp({ messages = [], at = Date.now() } = {}) {
  const st = await readState();
  const prevStage = st.stage;
  if (!st.enabled) {
    return { stage: st.stage, upgraded: false, prevStage, points: st.points };
  }
  const since = Number(st.stageSince) || 0;
  const count = (messages || []).filter((m) => m && !m.pending && (Number(m.createdAt) || 0) >= since).length;
  if (count > st.stageMessages) st.stageMessages = count;
  const moved = advance(st, at);
  if (moved || count > 0) {
    st.updatedAt = at;
    await writeState(st);
  }
  if (moved) emit({ stage: moved, prevStage, points: st.points });
  return { stage: st.stage, upgraded: !!moved, prevStage, points: st.points };
}

/**
 * 按历史消息重算亲密度（补算用）。
 *
 * 为什么要有它：0.4.1 之前只有「聊一句 +1」，老用户把几年聊天记录导进来时这些记录一条都没加过点，
 * 档位一直停在「相识」，信也就永远只有第一封。老大原话：「以前有的聊天记录如果能读到的话
 * 补发信和加好感度」。所以这里把历史消息按同一套规则重放一遍。
 *
 * 只写点数和档位，**不发事件**（补算不是「刚刚升阶」，界面不该弹一堆升阶提示）；
 * `letters` 一个字都不动 —— 已经写过的信不能被补算抹掉。
 *
 * @param {{points:number, stage:string, stageSince?:number, stageMessages?:number, lastDay?:string}} plan
 */
export async function seedFromHistory(plan) {
  const st = await readState();
  const next = {
    ...st,
    points: Math.max(0, Number(plan && plan.points) || 0),
    stage: STAGES.some((s) => s.id === (plan && plan.stage)) ? plan.stage : st.stage,
    stageSince: Number(plan && plan.stageSince) || st.stageSince || 0,
    stageMessages: Math.max(0, Number(plan && plan.stageMessages) || 0),
    lastDay: (plan && plan.lastDay) || st.lastDay || '',
    updatedAt: Date.now(),
  };
  return snapshotOf(await writeState(next));
}

/** 全部清零（换设备重来 / 用户主动重置）。只清亲密度，聊天记录一条不动。 */
export async function reset() {  const st = defaultState();
  st.updatedAt = Date.now();
  st.enabled = true;
  await writeState(st);
  emit({ stage: st.stage, prevStage: st.stage, points: 0, reset: true });
  return snapshotOf(st);
}

// —— 契约里的名字（电脑版口径），照抄一份别名，调用方用哪套都行 ——
/** 契约名：读整份亲密度状态。 */
export const readBond = snapshot;
/** 契约名：一条消息记一点。`role` 现在不参与计算，留着给将来区分主动/被动。 */
export const addMessagePoint = (role, at) => touchMessage({ at: Number(at) || Date.now() });
