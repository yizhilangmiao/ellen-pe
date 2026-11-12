// 事件表 + 余怨 + 第一次 + 被晾着 + 安全词 + 注入块渲染（排期 E2、E3）。
//
// 为什么和 affect.js 分开：那边是「时间自己在走」（衰减、收敛、软上限），这边是「发生了什么」
// （一句话、一个举动改值）。两者混在一个文件里，读代码的人会分不清「这个数是自己掉下来的
// 还是被打下来的」——而这两个问题的排查方式完全不同。
//
// 注入块（E3）也放在这里：它要读余怨和「第一次」，那两样只在这份文件里产生。
// 事件表 22 条逐条照抄 md笔记/手机版-记忆与情绪-现状与方案-2026-11-13.md 第五章那张表。
import {
  HOUR,
  awakeMsBetween,
  clampDim,
  derivedMood,
  effectiveDesire,
  bandOf,
  coldness,
  DIMS,
} from './affect.js';

/** 单次封顶 ±6：骂十句不会把好感一次打穿（安全词与「事后」除外，见下）。 */
export const EVENT_CAP = 6;
/** 同类一小时内的递减窗口。 */
export const SAME_KIND_WINDOW_MS = HOUR;
/** 安全词：性欲 −30、不封顶、立刻停 30 分钟。 */
export const SAFE_WORD = { lustDrop: 30, pauseMs: 30 * 60e3 };
/** 被晾着：清醒时长超过 6 小时算冷落。 */
export const NEGLECT_HOURS = 6;
/** 余怨压多久（天）。 */
export const GRUDGE_DAYS = { leave: 3, lie: 2, force: 2, scold: 1 };
const DAY_MS = 86400000;

/**
 * 22 条事件表。`delta` 是「第一条」的满额效果，实际落地要先乘同类递减、再夹 ±6。
 * `noCap` 只有「事后」：它是收尾结算不是一句话，按 −6 截断等于把整条抵消掉，
 * 「事后性欲 −25」这个语义就不存在了（这一条已写进交付说明，等老大拍板）。
 */
export const EVENTS = {
  // —— 好话 11 条 ——
  praise: { label: '夸奖', side: 'good', delta: { affection: 2, lust: 2, shame: 2, resist: -1 } },
  soothe: { label: '哄她', side: 'good', delta: { affection: 3, fatigue: -4, resist: 2 } },
  intimate: { label: '亲密', side: 'good', delta: { lust: 4, shame: -3, affection: 2 }, first: 'touch' },
  askDirect: { label: '直白要', side: 'good', delta: { lust: 5, lewd: 3, shame: -4 }, first: 'asked' },
  protect: { label: '护着', side: 'good', delta: { affection: 3, fatigue: -2 } },
  apologize: { label: '道歉', side: 'good', delta: { affection: 2, possess: -2 } },
  promise: { label: '承诺', side: 'good', delta: { affection: 3, possess: 2, resist: 2 } },
  tease: { label: '撩一下', side: 'good', delta: { lust: 3, shame: -2, resist: -1 } },
  gift: { label: '送东西', side: 'good', delta: { affection: 2, possess: 1 } },
  coax: { label: '哄软', side: 'good', delta: { lust: 3, shame: -2, resist: -2 } },
  aftercare: {
    label: '事后',
    side: 'good',
    // 口径：事后不封顶，待老大复核。
    // 为什么单独开这个口子：它是收尾结算不是一句话，−25 被 ±6 截成 −6 等于整条事件失效，
    // 「做完了会累、会退」这个循环就不存在了。Lead 已确认先按不封顶走。
    noCap: true,
    delta: { lust: -25, shame: 8, fatigue: 6, affection: 3, resist: 5 },
  },

  // —— 坏话 11 条 ——
  cold: { label: '冷淡', side: 'bad', delta: { affection: -2, lust: -3, possess: 1 } },
  refuse: { label: '拒绝', side: 'bad', delta: { lust: -6, resist: 8, shame: 3 } },
  ignore: { label: '无视', side: 'bad', delta: { affection: -3, possess: 2 } },
  mentionOther: { label: '提别人', side: 'bad', delta: { possess: 5, affection: -2 } },
  compare: { label: '和别人比', side: 'bad', delta: { affection: -4, possess: 3 } },
  scold: { label: '凶她', side: 'bad', delta: { affection: -4, lust: -4, shame: -3 }, grudge: 'scold' },
  lie: { label: '撒谎', side: 'bad', delta: { affection: -5 }, grudge: 'lie' },
  leave: {
    label: '说要走',
    side: 'bad',
    delta: { affection: -8, possess: 4, resist: 5 },
    grudge: 'leave',
    first: 'leave',
  },
  force: { label: '硬来', side: 'bad', delta: { affection: -5, resist: 4, shame: -4 }, grudge: 'force' },
  bodyShame: { label: '嫌身材', side: 'bad', delta: { affection: -5, shame: 5 } },
  neglected: { label: '晾着', side: 'bad', delta: { affection: -3, possess: 2 } },
};

export const EVENT_KEYS = Object.keys(EVENTS);

/** 余怨的中文说法（注入块与调试页共用）。 */
const GRUDGE_TEXT = {
  leave: '说要走',
  lie: '撒谎',
  force: '硬来',
  scold: '凶我',
};

function pruneRecent(state, at) {
  const keep = (state.recent || []).filter((r) => r && at - Number(r.at || 0) < SAME_KIND_WINDOW_MS);
  state.recent = keep.slice(-40);
  return keep;
}

/** 同类一小时内第 n 次 → 系数 1/(1+n)。第一次 n=0，不打折。 */
export function sameKindScale(state, type, at = Date.now()) {
  const recent = pruneRecent(state, at);
  const n = recent.filter((r) => r.type === type).length;
  return 1 / (1 + n);
}

/**
 * 落地一条事件。
 * @param {object} state settle 过的状态（原地改）
 * @param {object} p { type, at, ignorePause }
 * @returns {{skipped?:string, type?:string, scale?:number, applied?:object, grudge?:object, first?:string}}
 */
export function applyEvent(state, { type, at = Date.now(), ignorePause = false, markActivity = true } = {}) {
  const def = EVENTS[type];
  if (!def) return { skipped: 'unknownType', type };
  // 安全词之后的 30 分钟：不接任何撩拨（不然「停下」立刻被下一句推翻）
  if (!ignorePause && state.pausedUntil && at < state.pausedUntil) {
    return { skipped: 'paused', type, until: state.pausedUntil };
  }

  const scale = sameKindScale(state, type, at);
  const applied = {};
  for (const dim of DIMS) {
    const base = def.delta[dim];
    if (!base) continue;
    let delta = base * scale;
    if (!def.noCap) delta = Math.max(-EVENT_CAP, Math.min(EVENT_CAP, delta));
    const before = state.dims[dim];
    const after = clampDim(before + delta);
    if (after !== before) applied[dim] = { delta: after - before };
    state.dims[dim] = after;
  }

  // 余怨：说要走压 3 天、撒谎/硬来 2 天、凶一句 1 天。同一种再来就刷新到新的 until。
  let grudge = null;
  if (def.grudge) {
    const days = GRUDGE_DAYS[def.grudge] || 1;
    grudge = { kind: def.grudge, at, until: at + days * DAY_MS, label: GRUDGE_TEXT[def.grudge] };
    state.grudges = (state.grudges || []).filter((g) => g.kind !== def.grudge).concat(grudge).slice(-8);
  }

  // 第一次：各只触发一次，24 小时内带专属语气（判 24h 在渲染那边做，这里只记时间戳）
  let first = null;
  if (def.first) {
    if (!state.firsts) state.firsts = {};
    if (!state.firsts[def.first]) {
      state.firsts[def.first] = at;
      first = def.first;
    }
  }

  pruneRecent(state, at);
  state.recent = (state.recent || []).concat({ type, at }).slice(-40);
  // 「晾着」不是他说话：不动 lastEventAt，否则计时器每读一次就被重置，永远扣不到
  if (markActivity) state.lastEventAt = at;
  return { type, label: def.label, scale, applied, grudge, first };
}

/**
 * 安全词：不封顶、性欲 −30、立刻停 30 分钟。
 * 单独一个函数而不是事件表里一条 —— 事件表里的东西都要走「递减 + 封顶」，
 * 这条恰恰是例外，混进去早晚被谁顺手加上 cap。
 */
export function applySafeWord(state, { at = Date.now() } = {}) {
  const before = state.dims.lust;
  state.dims.lust = clampDim(before - SAFE_WORD.lustDrop);
  state.pausedUntil = at + SAFE_WORD.pauseMs;
  state.recent = (state.recent || []).concat({ type: 'safeWord', at }).slice(-40);
  state.lastEventAt = at;
  return { ok: true, type: 'safeWord', lust: { before, after: state.dims.lust }, pausedUntil: state.pausedUntil };
}

/** 当前还有效的余怨（未到期）。 */
export function activeGrudges(state, now = Date.now()) {
  return (state.grudges || []).filter((g) => g && Number(g.until) > now);
}

/** 24 小时内触发过的「第一次」。 */
export function recentFirsts(state, now = Date.now()) {
  const out = [];
  const firsts = state.firsts || {};
  for (const key of Object.keys(firsts)) {
    const at = Number(firsts[key]) || 0;
    if (at && now - at < 24 * HOUR && at <= now) out.push({ key, at });
  }
  return out;
}

/** 被晾着：清醒时长（睡眠窗里的沉默不算）。 */
export function neglectInfo(state, now = Date.now()) {
  const since = Number(state.lastEventAt) || Number(state.lastSettle) || now;
  const awakeHours = awakeMsBetween(since, now) / HOUR;
  return {
    since,
    awakeHours,
    neglected: awakeHours > NEGLECT_HOURS,
    // 每段沉默只记一次失望：记过就不再记，直到他真说话把 lastEventAt 推走
    already: !!(state.neglectAt && state.neglectAt >= since),
  };
}

/**
 * 该扣就扣一次「晾着」。
 * 注意这里**不动 lastEventAt**：晾着不是他说话，动了就等于把计时器重置，
 * 每读一次状态都「刚被晾 0 小时」，永远扣不到。markActivity:false 就是这个意思。
 */
export function applyNeglect(state, { now = Date.now() } = {}) {
  const info = neglectInfo(state, now);
  if (!info.neglected || info.already) return { ...info, applied: false };
  applyEvent(state, { type: 'neglected', at: now, markActivity: false });
  state.neglectAt = now;
  return { ...info, applied: true };
}

// —— E4：一句话 → 22 个事件键（纯本地，不花任何模型请求）——

/**
 * 为什么用关键词表而不是让模型分类：每条消息多一次请求 = 每条消息多两秒和一分钱，
 * 而情绪收益是「细微偏移」这一级的，不值这个价。关键词表可解释、可测试、离线可用，
 * 命不中就是 none —— 漏判只是少一次微调，误判有 ±6 封顶和同类递减兜着，都不会崩。
 */

/** 否定式：这些是「别停」「不要停下」，语义和安全词正好相反，必须先排掉。 */
const SAFE_WORD_NEGATED = /(别|不要|不用|不许|不想)(再)?(停|停下|停手|停一下)|继续|别停/;

/**
 * 安全词：独立先判，不进 22 条表。
 * 「停」单字只在短句里算（「停」是一句话，是命令；「停雨了」是陈述）。
 */
export function isSafeWord(text) {
  const src = String(text == null ? '' : text).replace(/\s+/g, '').trim();
  if (!src) return false;
  if (SAFE_WORD_NEGATED.test(src)) return false;
  if (/安全词/.test(src)) return true;
  if (/停手|停下|停一下|先停|打住|到此为止/.test(src)) return true;
  return src.length <= 4 && /^停[了吧啊。!！]?$/.test(src);
}

/**
 * 规则表：从上往下第一条命中就算。
 * 排序就一条原则 —— **越具体、后果越重的越靠前**（「你走吧」不能被「不想」抢走），
 * 「嗯」「哦」这种极短消息放最后（它是最弱的信号，但确实是「无视」）。
 */
const RULES = [
  { type: 'leave', re: /分手|离开你|你走吧|别找我了|不处了|各走各的|不想再见|我搬走|我们算了吧/ },
  { type: 'lie', re: /骗|撒谎|说谎|瞒着|没跟你说实话/ },
  { type: 'force', re: /硬来|强行|不管你愿不愿意|按住|别动，我/ },
  { type: 'bodyShame', re: /胖了|腿粗|腰粗|平胸|胸小|变丑|身材.{0,3}(差|不行|走样)|你该减肥/ },
  { type: 'compare', re: /(人家|别人|前任|我同事|那个女生).{0,8}(比|都不|更|多)|比你|学学人家|不如人家/ },
  { type: 'mentionOther', re: /前女友|前任|(和|跟|约)(一个|个)?(女生|女孩|妹子)|(她|他)今天.{0,6}说/ },
  { type: 'scold', re: /闭嘴|烦不烦|滚|有病|讨厌你|废物|别烦我|你有毛病/ },
  { type: 'refuse', re: /不行|不要|不想做|别碰|拒绝|改天吧|下次吧|没心情/ },
  { type: 'cold', re: /就这样吧|无所谓|你随意|随便你|不想聊|没什么好说/ },
  { type: 'ignore', re: /不想说|算了吧|算了|随便吧|呵呵|^[嗯哦噢啊哈]{1,2}[。！?!！]*$/ },
  { type: 'apologize', re: /对不起|抱歉|我错了|是我不好|别生气|原谅我/ },
  { type: 'promise', re: /答应你|我保证|以后不|会一直|我发誓|说好了/ },
  { type: 'aftercare', re: /做完|抱一会儿|抱一会|抱你睡|还好吗|累不累/ },
  { type: 'askDirect', re: /想要你|我要你|忍不住了|今晚别走|脱了|给我/ },
  { type: 'intimate', re: /亲|抱|吻|摸|贴着你|蹭/ },
  { type: 'protect', re: /我护着|别怕|有我在|我陪你|交给我|我挡着/ },
  { type: 'soothe', re: /乖|别难过|哄你|不哭|慢慢来|别急|辛苦了/ },
  { type: 'coax', re: /听话|乖一点|不生气|就一下|好不好嘛|求你/ },
  { type: 'tease', re: /逗你|撩|想你脸红|害羞了|想看|调戏/ },
  { type: 'gift', re: /给你买|送你|礼物|带了|买了|快递/ },
  { type: 'praise', re: /好看|真乖|好厉害|最喜欢你|你怎么这么|可爱|漂亮|好棒/ },
];

/** 这条消息命中了哪个事件键（不落盘、不发请求）。 */
export function classify(text) {
  const src = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!src) return { type: '', safeWord: false, hit: '' };
  if (isSafeWord(src)) return { type: '', safeWord: true, hit: src.slice(0, 8) };
  for (const rule of RULES) {
    const m = src.match(rule.re);
    if (m) return { type: rule.type, safeWord: false, hit: m[0] };
  }
  return { type: '', safeWord: false, hit: '' };
}

/**
 * 一句话走完整条路：安全词 → 事件 → 落状态。main.js 只调这一个。
 * @returns {{type:string, safeWord:boolean, hit:string, deltas:Object}}
 */
export function applyUtterance(state, text, { now = Date.now() } = {}) {
  const hit = classify(text);
  if (hit.safeWord) {
    const before = { ...state.dims };
    applySafeWord(state, { at: now });
    return { ...hit, deltas: diffDims(before, state.dims) };
  }
  if (!hit.type) {
    // 没命中也要推 lastEventAt：他说话了，就不算被晾着（这是「被晾着」的计时基准）
    state.lastEventAt = now;
    return { ...hit, deltas: {} };
  }
  const before = { ...state.dims };
  applyEvent(state, { type: hit.type, at: now });
  return { ...hit, deltas: diffDims(before, state.dims) };
}

function diffDims(before, after) {
  const out = {};
  for (const k of DIMS) {
    const d = after[k] - before[k];
    if (Math.abs(d) >= 0.01) out[k] = Math.round(d * 100) / 100;
  }
  return out;
}

// —— E3：注入块 ——

/** 数汉字（不算标点、字母、数字）。250 的预算按汉字算，标点不算钱。 */
export function countHan(text) {
  const m = String(text || '').match(/[\u4e00-\u9fff]/g);
  return m ? m.length : 0;
}

export const INJECTION_MAX_HAN = 220;

/** 档位句：五档各一句，语气必须能听出差别（心里想 vs 直接要）。 */
const BAND_LINES = {
  inner: '心里是有点想的，嘴上不认，你先动我才好回应。',
  hint: '有点想，但没说，只把话往那儿带一句，看你能不能接。',
  ask: '想要这件事，今天打算说出口，不绕弯子。',
  approach: '想凑过去，先挨着你的胳膊，再看你会不会躲。',
  direct: '身体已经不听劝了，我就想直接要你，话说得比平时露。',
};

/**
 * 补齐第二句用的尾巴。
 * 为什么需要：文档要求「第一人称 2–4 句」，而一切正常的时候往往只剩一句处境
 * （没冷、没累、没余怨）。一句读起来像标签，不像处境，模型会照抄成一句话回复。
 */
const BAND_TAILS = {
  inner: '想归想，不会先伸手。',
  hint: '你要是没接，我就当没说过。',
  ask: '说出口之后，耳朵是热的。',
  approach: '被躲开也不生气，退回来就好。',
  direct: '忍不住就不忍了。',
  neutral: '想的是别的，比如你今天累不累。',
};

/** 低欲望的中性块：不冷也不热，只是安静待着（「没探测到」不等于「不可用」）。 */
const NEUTRAL_LINE = '这会儿不想那些，靠过来也不躲，安静待着就行。';

/** 三种冷分开说：身体冷 / 话冷 / 心冷；三样同时冷才是公事公办。 */
const COLD_LINES = {
  body: '身体是淡的，被碰到会先躲一下。',
  words: '说话很正经，界限会划清楚，不接那种玩笑。',
  heart: '心里是远的，客气得像对同事，问一句答一句。',
  all: '身体、话、心都冷着，就是公事公办的样子。',
};

const EXTRA_LINES = {
  tired: '累了，句子会短，不推进话题，只想被抱着。',
  jealous: '有点吃醋，会试探你，语气带刺。',
  shy: '嘴上说不要，其实是等着被追。',
  stubborn: '嘴上说得硬，说不要，说完也没真走，就留在原地。',
  paused: '刚停下来，这半小时不接任何撩拨，先缓一缓。',
};

const GRUDGE_LINES = {
  leave: (day) => `${day}那句要走我还没过去，今天不会主动提。`,
  lie: (day) => `${day}那句谎我还记着，先不拆穿。`,
  force: (day) => `${day}你不管我愿不愿意，我还记着。`,
  scold: (day) => `${day}你凶我那一下还压着，今天话少。`,
};

const FIRST_LINES = {
  touch: '第一次被你碰到这件事，我今天还记着，反应比平时大一拍。',
  asked: '你第一次开口要我，我今天心里一直揣着。',
  leave: '你第一次说要走，我今天心里一直悬着。',
};

/** 相对日期：昨天 / 前天 / 前几天。只用于注入块，别拿去写日记。 */
function dayWord(at, now) {
  const days = Math.floor((now - at) / DAY_MS);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days === 2) return '前天';
  return '前几天';
}

/** 一句写法约束（文档给的那句，别改：它同时压住了长度与解释欲）。 */
const STYLE_LINE = '写法：2~4 句，动作放（），不解释为什么。';

/**
 * 渲染注入块。三条硬要求：
 *   1. 任何状态都不返回空串 —— 空串会让上层退回旧模板，你以为关掉了，其实换了个更差的在说话；
 *   2. 第一人称 2–4 句 + 一句写法约束，总长 ≤ 220 汉字；
 *   3. 三种冷分开说，别笼统写「心情不好」。
 */
export function renderInjection(state, { now = Date.now() } = {}) {
  const dims = state.dims;
  const eff = effectiveDesire(dims);
  const band = bandOf(eff);
  const cold = coldness(dims);

  const sentences = [];
  const neutral = eff < 20;
  sentences.push(neutral ? NEUTRAL_LINE : BAND_LINES[band.id] || BAND_LINES.inner);

  // 三种冷：全冷合并成一句（公事公办），否则各自说清是哪一层冷
  if (cold.body && cold.words && cold.heart) sentences.push(COLD_LINES.all);
  else {
    if (cold.body) sentences.push(COLD_LINES.body);
    if (cold.words) sentences.push(COLD_LINES.words);
    if (cold.heart) sentences.push(COLD_LINES.heart);
  }

  // 余怨最要紧：三天前那句「要走」还在，这就是她今天话少的原因
  for (const g of activeGrudges(state, now).slice(-1)) {
    const line = GRUDGE_LINES[g.kind];
    if (line) sentences.push(line(dayWord(Number(g.at) || now, now)));
  }

  // 第一次：24 小时内带专属语气，过后自然失效（不删时间戳，留着给手记）
  for (const f of recentFirsts(state, now).slice(0, 1)) {
    const line = FIRST_LINES[f.key];
    if (line) sentences.push(line);
  }

  if (state.pausedUntil && state.pausedUntil > now) sentences.push(EXTRA_LINES.paused);
  // 嘴上硬（五章 2 表「回复」行）：理智高 + 性欲也高 —— 嘴上不认，人没走。
  // 为什么单独一句：档位只说了「想不想要」，说不清「想要却嘴硬」这种最像她的状态，
  // 只靠档位模型会把这段演成冷淡（冷淡和嘴硬对用户是两件事）。
  if (dims.resist > 60 && dims.lust > 55) sentences.push(EXTRA_LINES.stubborn);
  if (dims.fatigue > 65) sentences.push(EXTRA_LINES.tired);
  if (dims.possess > 75) sentences.push(EXTRA_LINES.jealous);
  if (dims.shame > 70) sentences.push(EXTRA_LINES.shy);

  // 只有一句时补个尾巴：一句是标签，两句才是处境（见 BAND_TAILS 的注释）
  if (sentences.length < 2) sentences.push(neutral ? BAND_TAILS.neutral : BAND_TAILS[band.id]);

  // 预算：保留第一句（处境）与写法约束，其余按优先级从尾部砍，砍到 220 汉字以内
  const clause = `[此刻] ${sentences[0]}`;
  const ordered = sentences.slice(1);
  // 最多 4 句（含首句），超了就丢后面的 —— 句子再多就不像处境，像清单
  const kept = ordered.slice(0, 3);
  let head = [clause, ...kept].join('');
  while (countHan(head) + countHan(STYLE_LINE) > INJECTION_MAX_HAN && kept.length) {
    kept.pop();
    head = [clause, ...kept].join('');
  }
  const text = `${[clause, ...kept].join('')}\n${STYLE_LINE}`;
  return text;
}

/** 调试页要的一行摘要：档位、触发到的句子数、汉字数。 */
export function injectionInfo(state, { now = Date.now() } = {}) {
  const text = renderInjection(state, { now });
  const eff = effectiveDesire(state.dims);
  const band = bandOf(eff);
  return {
    text,
    han: countHan(text),
    max: INJECTION_MAX_HAN,
    band: { id: band.id, label: band.label, min: band.min },
    mood: derivedMood(state),
    grudges: activeGrudges(state, now),
    firsts: recentFirsts(state, now),
    neglect: neglectInfo(state, now),
  };
}

/**
 * 把情绪拼进 system prompt：人格提示 + 注入块 + 回复姿态。
 *
 * 为什么收在这一处而不是散在 main.js 的字符串拼接里：这三段是有顺序和预算的
 * （注入块必须紧贴人格提示，长度/姿态在最后），散着写两天就有人插在中间。
 * 也为了让 node 能直接跑测试 —— main.js 带 CSS 和 DOM，节点里 import 不了。
 */
export function attachToPrompt(base, state, { now = Date.now(), styleLine = '' } = {}) {
  const parts = [String(base == null ? '' : base).trim()];
  const block = state ? renderInjection(state, { now }) : '';
  if (block) parts.push(block);
  if (styleLine) parts.push(String(styleLine).trim());
  return parts.filter(Boolean).join('\n');
}
