// 星图：把聊天、手记、记忆、信摊成一张可点击的星图（纯坐标计算，不碰 DOM、不碰 canvas）。
//
// 为什么要在这里算坐标而不是在视图里：星图是「同一份数据换个看法」，
// 布局一旦跟渲染搅在一起，就再也没法在 node 里验证「500 条记录会不会画出 500 个点」。
// 所以这里只有两件事：把记录归到周列里 → 超过上限就线性抽稀。
import { listLatest } from './store/library.js';
import { dayKey } from './bond.js';

/** 星点上限：再多手机上也点不准，超了按时间均匀抽稀。 */
export const MAX_POINTS = 400;
/** 每类记录一次最多捞多少条（抽稀在捞回来之后做，这里只是防止一次读爆内存）。 */
const LOAD_LIMIT = 2000;

const COLUMN_WIDTH = 12;
const WEEK_RADIUS = 4.2;
const DAY_MS = 86400000;

/** 记录类型 → 星点类型（聊天记录在存储里叫 message）。 */
const KIND_MAP = { message: 'chat', chat: 'chat', journal: 'journal', memory: 'memory', letter: 'letter' };

/** 星点半径：越稀有越大，一眼能看出「信」和「手记」比聊天重要。 */
const RADIUS = { chat: 1.6, journal: 2.4, memory: 3, letter: 3.8 };

const KIND_ORDER = ['chat', 'journal', 'memory', 'letter'];

/** 稳定的伪随机：同一个 id 每次算出来一样，星图才不会每次打开都跳。 */
function hashish(str) {
  let h = 2166136261;
  const s = String(str || '');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

function textOf(value) {
  if (!value || typeof value !== 'object') return '';
  return String(value.title || value.diary || value.text || value.content || value.summary || value.body || '');
}

// ── 事件之间的联系 ──────────────────────────────────────────────────
// 光有时间线，星图只是一串孤立的点。真正让人「啊」一下的是横着的那几笔：
// 十月的「加班到十点」和这周的「又在加班」其实是一件事。
// 连线依据只有一条铁律：**可解释**。共享关键词 / 字面相近 / 同类型，三者加权，
// 低于门槛就不连 —— 宁可少，也不要随机连出一张蜘蛛网。

/** 虚词：两个词之间夹着这些字的 bigram 没有信息量（「的话」「时候」「一个」）。 */
const STOP_CHARS = new Set([
  ...'的了是在和有就都也很不我你他她它们这那吗呢吧啊哦嗯呀嘛把被给让对从而且所以因为如果可是没有一个什么怎么这样那样的话时候还要会能去来到说做想觉得然后但是只是真的特别有点一直',
]);

/** 一个词出现在太多点里就失去区分度（「今天」「晚上」），不当连线依据。 */
const HUB_KEYWORD_MAX = 40;
/** 当主题名用的词得更少见：说三五次才叫「同一件事」，说十几次那是背景音。 */
const CLUSTER_MAX_FREQ = 8;
/** 这些词天天出现，串起来的不是主题，是日历和口水话。 */
const GENERIC_WORDS = new Set([
  '今天', '昨天', '明天', '今天天', '天天', '晚上', '早上', '上午', '下午', '中午', '现在', '刚才',
  '最近', '以后', '之前', '时候', '一直', '有点', '可能', '觉得', '真的', '然后', '但是', '因为',
  '所以', '还是', '就是', '这样', '那样', '自己', '我们', '你们', '他们', '东西', '事情', '一个',
  '什么', '怎么', '可以', '应该', '一起', '有点点', '不好', '不是', '没有', '知道',
  '聊天', '记忆', '手记', '写信', '朋友', '刚才', '听见',
]);
/** 每个点最多连几条「非时间」的线。 */
const TIE_MAX_NEIGHBORS = 1;
/** 连线门槛：低于这个分数宁可不连。 */
const TIE_MIN_SCORE = 0.34;

/**
 * 抽关键词：中文按二字滑窗，英文数字按整词；虚词组合丢掉。
 * @param {string} text
 * @param {number} max
 * @returns {string[]}
 */
export function keywordsOf(text, max = 5) {
  const clean = String(text ?? '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]+/g, ' ').trim();
  if (!clean) return [];
  const counts = new Map();
  const bump = (key) => {
    if (key.length < 2) return;
    counts.set(key, (counts.get(key) || 0) + 1);
  };
  clean.split(/\s+/).forEach((segment) => {
    if (/^[a-zA-Z0-9]+$/.test(segment)) {
      if (segment.length >= 2) bump(segment.toLowerCase());
      return;
    }
    for (let i = 0; i + 2 <= segment.length; i += 1) {
      const bigram = segment.slice(i, i + 2);
      if ([...bigram].some((ch) => STOP_CHARS.has(ch))) continue;
      bump(bigram);
    }
  });
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([key]) => key);
}

/** 两段话的二字滑窗余弦相似（0–1）。 */
export function bigramSimilarity(a, b) {
  const bag = (text) => {
    const clean = String(text ?? '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]+/g, ' ').trim();
    const map = new Map();
    clean.split(/\s+/).forEach((segment) => {
      if (!segment) return;
      if (/^[a-zA-Z0-9]+$/.test(segment)) {
        map.set(segment.toLowerCase(), (map.get(segment.toLowerCase()) || 0) + 1);
        return;
      }
      for (let i = 0; i + 2 <= segment.length; i += 1) {
        const bigram = segment.slice(i, i + 2);
        if ([...bigram].some((ch) => STOP_CHARS.has(ch))) continue;
        map.set(bigram, (map.get(bigram) || 0) + 1);
      }
    });
    return map;
  };
  const ba = bag(a);
  const bb = bag(b);
  if (!ba.size || !bb.size) return 0;
  let dot = 0;
  ba.forEach((count, key) => { if (bb.has(key)) dot += count * bb.get(key); });
  if (!dot) return 0;
  const norm = (map) => Math.sqrt([...map.values()].reduce((sum, v) => sum + v * v, 0)) || 1;
  return dot / (norm(ba) * norm(bb));
}

/**
 * 算「事件之间」的连线（跟时间无关的那几笔）。
 * @param {Array<{kind:string,hint:string,label:string,x:number,y:number}>} points
 * @param {Array<{hint?:string,label?:string}>} raws 与 points 一一对应
 * @returns {Array<{a:number,b:number,score:number,kind:string,x1:number,y1:number,x2:number,y2:number,cx:number,cy:number}>}
 */
function layoutTies(points, raws) {
  const n = points.length;
  if (n < 3) return [];
  const texts = points.map((p, i) => `${(raws[i] && raws[i].hint) || ''} ${(raws[i] && raws[i].label) || ''}`.trim());
  const keys = texts.map((t) => new Set(keywordsOf(t, 5)));

  const buckets = new Map();
  keys.forEach((set, i) => {
    set.forEach((k) => {
      const list = buckets.get(k);
      if (list) list.push(i);
      else buckets.set(k, [i]);
    });
  });

  const pairs = new Map();
  const consider = (i, j) => {
    if (i === j) return;
    // 时间线上紧挨着的两点本来就有一条弧线，别再横着补一刀
    if (Math.abs(i - j) <= 1) return;
    const a = Math.min(i, j);
    const b = Math.max(i, j);
    const key = `${a}|${b}`;
    if (pairs.has(key)) return;
    let shared = 0;
    keys[a].forEach((k) => { if (keys[b].has(k)) shared += 1; });
    const keywordScore = shared / Math.max(1, Math.min(keys[a].size, keys[b].size));
    const wordScore = bigramSimilarity(texts[a], texts[b]);
    const kindScore = points[a].kind === points[b].kind ? 1 : 0;
    const score = 0.46 * keywordScore + 0.34 * wordScore + 0.2 * kindScore;
    if (score < TIE_MIN_SCORE) return;
    pairs.set(key, { a, b, score });
  };

  buckets.forEach((list) => {
    if (list.length < 2 || list.length > HUB_KEYWORD_MAX) return;
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) consider(list[i], list[j]);
    }
  });

  const perNode = new Map();
  const out = [];
  [...pairs.values()]
    .sort((a, b) => b.score - a.score)
    .forEach((pair) => {
      const ca = perNode.get(pair.a) || 0;
      const cb = perNode.get(pair.b) || 0;
      if (ca >= TIE_MAX_NEIGHBORS || cb >= TIE_MAX_NEIGHBORS) return;
      perNode.set(pair.a, ca + 1);
      perNode.set(pair.b, cb + 1);
      const pa = points[pair.a];
      const pb = points[pair.b];
      // 弧线朝背离河心的方向鼓出去，鼓多少看两点隔多远：
      // 隔得近就是轻轻一挑；隔得远（十天前和今天）要甩成一个大弯，绕过整条河，
      // 否则在屏幕上就是一束贴着河的竖直虚线，看着像「重影」而不是「联系」。
      const dy = Math.abs(pa.y - pb.y);
      const bow = ((pa.x + pb.x) / 2 >= 0 ? 1 : -1) * Math.min(88, Math.max(20, dy * 0.28));
      out.push({
        a: pair.a,
        b: pair.b,
        score: Number(pair.score.toFixed(3)),
        kind: pa.kind,
        x1: pa.x,
        y1: pa.y,
        x2: pb.x,
        y2: pb.y,
        cx: Number((((pa.x + pb.x) / 2) + bow).toFixed(3)),
        cy: Number(((pa.y + pb.y) / 2).toFixed(3)),
      });
    });
  return out;
}


function labelOf(kind, value) {
  const t = textOf(value).replace(/\s+/g, ' ').trim();
  if (kind === 'letter') {
    const title = String((value && value.title) || '').trim();
    if (title) return title.slice(0, 18);
    return '一封信';
  }
  if (!t) return { chat: '一句话', journal: '一篇手记', memory: '一段记忆', letter: '一封信' }[kind] || '一颗星';
  return t.slice(0, 18);
}

/** 把存储行压成星点需要的字段；不认识的行丢掉。 */
function toRaw(row) {
  if (!row) return null;
  // 已经是 raw 的直接放行：二次压会把 label 全推回兜底（见 loadRecords 上面那段）
  if (!row.value && typeof row.label === 'string' && row.ref !== undefined && row.at) return row;
  const kind = KIND_MAP[row.kind];
  if (!kind) return null;
  const at = Number(row.at || row.createdAt) || 0;
  if (!at) return null;
  const value = row.value || {};
  return {
    kind,
    at,
    ref: row.headId || row.revisionId || row.id || '',
    label: labelOf(kind, value),
    // 记忆/手记的正文可以给视图当悬浮提示；聊天只存一句，避免整张星图背着几 MB 文本
    hint: textOf(value).slice(0, 80),
    // 并事件要用：谁说的、哪个会话。老数据没有这两个字段也不影响
    role: String(value.role || ''),
    thread: String(value.threadId || ''),
  };
}

/**
 * 读四类记录，**原样返回**库里的行（`{headId,kind,at,value,...}`）。
 *
 * 这里以前在循环里就 `toRaw()` 了一次，而 layoutRiver / dayEvents 拿到之后又
 * `toRaw()` 一次 —— 二次 toRaw 时 `row.value` 已经是 undefined，于是 label 全
 * 落进兜底（聊天变成「一句话」、信变成「的信」），星星旁边的字全是废话。
 * 所以：读库只管读，压成 raw 这一步只在调用方做一次。
 */
async function loadRecords() {
  const out = [];
  for (const storeKind of ['message', 'journal', 'memory', 'letter']) {
    try {
      const rows = await listLatest(storeKind, { limit: LOAD_LIMIT });
      for (const row of rows) out.push({ ...row, kind: storeKind });
    } catch (err) {
      // 某一类读失败（比如老库没有 memory）不该让整张星图空着
      console.warn(`[starmap] 读取 ${storeKind} 失败`, err);
    }
  }
  return out;
}

/**
 * 线性抽稀：保留首尾（最早 / 最近都要在图上），中间按等距取。
 * @param {Array<object>} list 已按时间升序
 * @param {number} max
 */
function thin(list, max = MAX_POINTS) {
  const n = list.length;
  if (n <= max) return list.slice();
  if (max <= 1) return [list[n - 1]];
  const out = [];
  const step = (n - 1) / (max - 1);
  let lastIdx = -1;
  for (let i = 0; i < max; i += 1) {
    const idx = Math.round(i * step);
    if (idx === lastIdx) continue;
    out.push(list[idx]);
    lastIdx = idx;
  }
  return out;
}

/**
 * 纯布局：给一批记录，算星点坐标。**不读库、不碰 DOM**，可以单独验算。
 * @param {Array<object>} records 原始记录（`{kind, at, value, headId}`）
 * @param {{weeks?:number, now?:number}} [opts]
 * @returns {{points:Array, links:Array, bounds:object, clusters:Array, weeks:number, total:number, dropped:number}}
 */
export function layoutPoints(records = [], { weeks = 26, now = Date.now() } = {}) {
  const weekCount = Math.min(104, Math.max(1, Math.floor(Number(weeks) || 26)));
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const todayStart = today.getTime();

  const raws = [];
  for (const rec of records || []) {
    const raw = toRaw(rec);
    if (raw) raws.push(raw);
  }
  raws.sort((a, b) => a.at - b.at);
  const kept = thin(raws, MAX_POINTS);

  const points = [];
  const clusters = new Map();

  for (const raw of kept) {
    const dayStart = new Date(raw.at);
    dayStart.setHours(0, 0, 0, 0);
    const daysAgo = Math.floor((todayStart - dayStart.getTime()) / DAY_MS);
    const weekIndex = weekCount - 1 - Math.floor(daysAgo / 7);
    if (weekIndex < 0 || weekIndex >= weekCount) continue; // 窗口外的老记录不上图

    const dayInWeek = ((dayStart.getDay() + 6) % 7); // 周一起算，0=周一
    const seed = hashish(raw.ref || `${raw.kind}:${raw.at}`);
    const spread = (seed - 0.5) * 2 * WEEK_RADIUS;
    const drift = (hashish(`${raw.ref}:x`) - 0.5) * COLUMN_WIDTH * 0.7;

    const x = Number((weekIndex * COLUMN_WIDTH + drift).toFixed(3));
    const y = Number(((dayInWeek - 3) * WEEK_RADIUS + spread).toFixed(3));
    const point = {
      x,
      y,
      r: RADIUS[raw.kind] || 2,
      kind: raw.kind,
      date: dayKey(raw.at),
      label: raw.label,
      ref: raw.ref,
      at: raw.at,
    };
    points.push(point);

    const key = weekIndex;
    let c = clusters.get(key);
    if (!c) {
      c = { week: key, x: 0, y: 0, count: 0, kinds: {} };
      for (const k of KIND_ORDER) c.kinds[k] = 0;
      clusters.set(key, c);
    }
    c.x += x;
    c.y += y;
    c.count += 1;
    c.kinds[raw.kind] += 1;
  }

  // 同一条周列里相邻的星点连一条细线：让星团看起来是「一簇」而不是散沙
  const byWeek = new Map();
  for (const p of points) {
    const key = Math.round(p.x / COLUMN_WIDTH);
    if (!byWeek.has(key)) byWeek.set(key, []);
    byWeek.get(key).push(p);
  }
  const links = [];
  for (const list of byWeek.values()) {
    list.sort((a, b) => a.at - b.at);
    for (let i = 1; i < list.length; i += 1) {
      const a = list[i - 1];
      const b = list[i];
      links.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, kind: a.kind === b.kind ? a.kind : 'mixed', week: Math.round(b.x / COLUMN_WIDTH) });
    }
  }

  let minX = 0;
  let minY = 0;
  let maxX = 0;
  let maxY = 0;
  if (points.length) {
    minX = Math.min(...points.map((p) => p.x));
    maxX = Math.max(...points.map((p) => p.x));
    minY = Math.min(...points.map((p) => p.y));
    maxY = Math.max(...points.map((p) => p.y));
  }

  const clusterList = [...clusters.values()]
    .sort((a, b) => a.week - b.week)
    .map((c) => ({
      week: c.week,
      x: Number((c.x / c.count).toFixed(3)),
      y: Number((c.y / c.count).toFixed(3)),
      count: c.count,
      kinds: c.kinds,
    }));

  return {
    points,
    links,
    bounds: { minX, minY, maxX, maxY },
    clusters: clusterList,
    weeks: weekCount,
    total: raws.length,
    dropped: Math.max(0, raws.length - points.length),
  };
}

// ── 竖版「时间星河」（手机版定稿方案，2026-11-12）──────────────────────
//
// 老大口径：手机上要回答的是「她最近记住了什么」，不是「记忆拓扑长什么样」。
// 所以手机版不是圆团也不是周列，是一条从上往下、越往下越早的河：
//   · 中心星在顶部（屏高 1/6），樱粉；
//   · 记忆点统一暖白，只有「她在意的事」（memory）用一点青绿；
// 老大 2026-11-12 17:24 补两条：**不按日期排，按事件排**（一问一答 = 一颗星），
// 而且「不够密集」——所以间距比第一版紧、摆动幅度也收小，让一屏能看见十来件事。
//
// 这里同样只算坐标，不碰 DOM / canvas。

/** 每件事占的纵向高度（内容单位 = CSS px）。 */
export const RIVER_ITEM_GAP = 9;
/** 每隔几条插一道时间刻度（按事件排之后不再用，留着给老数据兜底）。 */
export const RIVER_RULER_EVERY = 5;
/** 换天时额外让出的高度。 */
export const RIVER_DAY_GAP = 16;
/** 刻度处额外让出的高度（同上，不再用）。 */
export const RIVER_RULER_GAP = 30;
/** 中心星 → 第一条记录的距离。 */
export const RIVER_HEAD_GAP = 52;
/** 河心到那一条的横向基准距离。 */
export const RIVER_SIDE_OFFSET = 40;
/** 左右轻微摆动的幅度 —— 是「河」不是「直线」。 */
export const RIVER_SWAY = 2;
// 带子的斜度（tan，0.26 ≈ 15°）与带的厚度（垂直散布半径，px）
export const RIVER_SHEAR = 0.26;
export const RIVER_DEPTH_SPREAD = 96;

/** 组（= 记录类型）落在河的哪一侧、叫什么。两侧都要有东西，河才成形。 */
export const RIVER_GROUPS = [
  { kind: 'chat', side: -1 },
  { kind: 'journal', side: -1 },
  { kind: 'memory', side: 1 },
  { kind: 'letter', side: 1 },
];

const GROUP_SIDE = RIVER_GROUPS.reduce((acc, g) => {
  acc[g.kind] = g.side;
  return acc;
}, {});

/** 时间河上的点半径：最近的最大，往下越旧越小（不额外解释，看一眼就懂）。 */
export const RIVER_RADIUS = { chat: 3.2, journal: 3.6, memory: 4.4, letter: 4.8 };

function monthDay(at) {
  const d = new Date(at);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

/**
 * 主题簇：把「被同一个词串起来的至少三件事」归成一簇，并拿那个词当名字。
 *
 * 为什么不复用 layoutTies 的边：那边为了画面干净，每个点只留一条线，图里永远只有两点一对，
 * 凑不出三点的簇。簇要的是「同一件事说过好几次」，所以这里放宽到「共享一个词就算边缘」，
 * 再用并查集把重叠的词并起来 —— 名字是构造出来的，不是猜的：那个词本来就压在成员身上。
 */
function buildClusters(points, kept) {
  const n = points.length;
  if (n < 3) return [];
  const keysOfPoint = points.map((p, i) => keywordsOf(`${(kept[i] && kept[i].hint) || ''} ${p.label || ''}`.trim(), 5));
  const buckets = new Map();
  keysOfPoint.forEach((keys, i) => keys.forEach((k) => {
    const list = buckets.get(k);
    if (list) list.push(i);
    else buckets.set(k, [i]);
  }));

  const parent = points.map((_, i) => i);
  const find = (i) => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    let cur = i;
    while (parent[cur] !== root) {
      const next = parent[cur];
      parent[cur] = root;
      cur = next;
    }
    return root;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  // 太常见的词（今天/晚上）不配当主题，也免得把所有点焊成一坨
  buckets.forEach((list, key) => {
    if (list.length < 2 || list.length > CLUSTER_MAX_FREQ) return;
    if (GENERIC_WORDS.has(key)) return;
    for (let i = 1; i < list.length; i += 1) union(list[0], list[i]);
  });

  const bags = new Map();
  points.forEach((_, i) => {
    const root = find(i);
    if (!bags.has(root)) bags.set(root, []);
    bags.get(root).push(i);
  });

  const docFreq = new Map();
  buckets.forEach((list, key) => docFreq.set(key, list.length));

  const clusters = [];
  bags.forEach((all, root) => {
    if (all.length < 3) return;
    const need = Math.max(2, Math.ceil(all.length * 0.5));
    const counts = new Map();
    all.forEach((i) => keysOfPoint[i].forEach((k) => {
      if (GENERIC_WORDS.has(k)) return;
      counts.set(k, (counts.get(k) || 0) + 1);
    }));
    let best = null;
    counts.forEach((count, key) => {
      if (count < need) return;
      if ((docFreq.get(key) || 0) > CLUSTER_MAX_FREQ) return;
      if (!best || count > best.count || (count === best.count && key.length < best.key.length)) {
        best = { key, count };
      }
    });
    if (!best) return;

    // 带子只圈「真的带这个词」的那几个，不然一个泛词会把半个图都框进去
    const members = all.filter((i) => keysOfPoint[i].includes(best.key));
    if (members.length < 3) return;

    const ys = members.map((i) => points[i].y);
    const y0 = Math.min(...ys);
    const y1 = Math.max(...ys);
    if (y1 - y0 < RIVER_ITEM_GAP * 1.5) return; // 挤在一行的三颗星不配叫主题

    const left = members.filter((i) => points[i].side < 0).length;
    const side = left >= members.length / 2 ? -1 : 1;
    const x = side * (RIVER_SIDE_OFFSET + RIVER_SWAY + 74);

    // 一个主题往往不是连着说的：隔了半个月又提一次，中间隔着几百条别的事。
    // 所以带子按「连着的那一段」画，不然一根括号要竖穿七八屏，看着像分隔线。
    const runs = [];
    let run = [members[0]];
    for (let i = 1; i < members.length; i += 1) {
      if (members[i] - members[i - 1] <= 4) run.push(members[i]);
      else {
        runs.push(run);
        run = [members[i]];
      }
    }
    runs.push(run);
    // 每一次「又提起」都留一截，哪怕那一次只提了一句：
    // 只留连着说的那一段，别的几次在图上等于没说过，主题就断了。
    const useRuns = runs;

    clusters.push({
      name: best.key,
      count: members.length,
      side,
      // 挂在河的外侧，避开星点和它们的字
      x,
      y0,
      y1,
      members,
      root,
      runs: useRuns.map((r, i) => {
        const yFrom = Math.min(...r.map((idx) => points[idx].y));
        const yTo = Math.max(...r.map((idx) => points[idx].y));
        const pad = RIVER_ITEM_GAP * 0.45;
        return {
          index: i,
          y0: Math.max(0, yFrom - pad),
          y1: yTo + pad,
          count: r.length,
          members: r,
        };
      }),
    });
  });

  clusters.sort((a, b) => b.count - a.count || a.y0 - b.y0);
  return clusters.slice(0, 3);
}

/**
 * 纯布局：竖版时间河。**不读库、不碰 DOM**，可以单独验算。
 * 坐标约定：x 相对河心（负=左），y 从中心星（0）往下增大，越大越早。
 * @param {Array<object>} records
 * @param {{now?:number, limit?:number}} [opts]
 */
/**
 * 把消息流并成「事件」：一问一答算一件事。
 *
 * 为什么不是一条消息一颗星：一天来回几十句，按消息排出来的河有三千多像素，
 * 划三屏才看完一天，那不叫「记得什么」，那叫聊天记录缩略图。
 * 合并规则很土但可解释：同一个话题（同 thread）、间隔 ≤45 分钟、最多收两轮；
 * 事件标题取「我那句」，摘要取「她那句」——她回的话才是内容。
 */
export function buildEvents(rawsAsc = [], { gapMs = 45 * 60 * 1000, maxMsgs = 4 } = {}) {
  const out = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const first = cur.msgs.find((m) => m.role === 'user') || cur.msgs[0];
    const rest = cur.msgs.filter((m) => m !== first);
    // 她那句可能有重复（同一句兜底提示回了两遍），只说一遍
    const seen = new Set();
    const said = [];
    for (const m of rest) {
      const t = String(m.hint || m.label || '').trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      said.push(t);
    }
    out.push({
      kind: 'chat',
      at: cur.at,
      ref: first.ref,
      label: first.label,
      hint: (said.length ? said.join(' ') : first.hint).slice(0, 80),
      count: cur.msgs.length,
    });
    cur = null;
  };
  for (const raw of rawsAsc || []) {
    if (raw.kind !== 'chat') {
      flush();
      out.push({ ...raw, count: 1 });
      continue;
    }
    const same = cur
      && cur.msgs.length < maxMsgs
      && raw.at - cur.lastAt <= gapMs
      && (!cur.thread || !raw.thread || cur.thread === raw.thread);
    if (same) {
      cur.msgs.push(raw);
      cur.lastAt = raw.at;
    } else {
      flush();
      cur = { at: raw.at, lastAt: raw.at, thread: raw.thread || '', msgs: [raw] };
    }
  }
  flush();
  return out;
}

export function layoutRiver(records = [], { now = Date.now(), limit = MAX_POINTS } = {}) {
  const raws = [];
  for (const rec of records || []) {
    const raw = toRaw(rec);
    if (raw) raws.push(raw);
  }
  raws.sort((a, b) => a.at - b.at); // 升序，为了 thin 保首尾
  // 先并成事件，再抽稀：按消息抽会把同一件事的两句拆到河的两头
  const events = buildEvents(raws);
  const keptAsc = thin(events, Math.max(1, Math.floor(limit) || MAX_POINTS));
  // 一模一样的话只留最新的一条：没配模型时那几条兜底提示会叠成三颗星，
  // 图上看着像「这三件事」，点开却是同一句 —— 那是噪声，不是记忆。
  const seenText = new Set();
  const kept = keptAsc.slice().reverse().filter((raw) => {
    const key = `${raw.kind}|${raw.label}|${String(raw.hint || '').slice(0, 24)}`;
    if (seenText.has(key)) return false;
    seenText.add(key);
    return true;
  }); // 新的在上
  const total = events.length;
  const n = kept.length;
  // 带子的斜度：整条河不是竖直的，越往下越往右漂一点，像一条斜插过屏幕的银河。
  // 0.26 ≈ 15°，再大就会把两端顶出屏幕（432 CSS 宽下 ±120px 已经是极限）。
  const midY = RIVER_HEAD_GAP + (n * RIVER_ITEM_GAP) / 2;
  const shearOf = (yy) => (yy - midY) * RIVER_SHEAR;

  const points = [];
  const rulers = [];
  const perGroup = new Map();

  let y = RIVER_HEAD_GAP;
  kept.forEach((raw, i) => {
    // 换天才提一句日期，不再每五条插一道刻度：
    // 刻度本来是给「按日期排」用的骨架，现在按事件排，日期只作注脚。
    if (i > 0 && dayKey(raw.at) !== dayKey(kept[i - 1].at)) {
      y += RIVER_DAY_GAP;
      rulers.push({ y, label: monthDay(raw.at), day: dayKey(raw.at) });
    }
    const seed = hashish(raw.ref || `${raw.kind}:${raw.at}`);
    const side = GROUP_SIDE[raw.kind] || -1;
    const swayPhase = y / 180 + seed * Math.PI * 2;
    // 伪深度：0 = 远景、1 = 近景。同一个 ref 永远同一个深度，刷新不会换位。
    const depth = hashish(`${raw.ref || raw.at}:z`);
    // 带的厚度：垂直方向 ±46px 散布，让「一条线」变成「一条有厚度的带」。
    const spread = (hashish(`${raw.ref || raw.at}:y`) - 0.5) * 2 * RIVER_DEPTH_SPREAD;
    const x = Number((
      side * (RIVER_SIDE_OFFSET + seed * 16)
      + Math.sin(swayPhase) * RIVER_SWAY
      + spread
      + shearOf(y)
    ).toFixed(3));
    // 新旧：0 = 最新、1 = 最旧。新的大而亮，旧的暗而小。
    const age = n > 1 ? i / (n - 1) : 0;
    const depthScale = 0.78 + depth * 0.46;
    const point = {
      x,
      y: Number(y.toFixed(3)),
      r: Number((((RIVER_RADIUS[raw.kind] || 3.2) * (1 - age * 0.42) + 0.6) * depthScale).toFixed(2)),
      alpha: Number(((0.95 - age * 0.52) * (0.58 + depth * 0.44)).toFixed(3)),
      age: Number(age.toFixed(3)),
      depth: Number(depth.toFixed(3)),
      kind: raw.kind,
      side,
      date: dayKey(raw.at),
      at: raw.at,
      label: raw.label,
      hint: raw.hint,
      ref: raw.ref,
      count: raw.count || 1,
    };
    points.push(point);

    if (!perGroup.has(raw.kind)) perGroup.set(raw.kind, []);
    perGroup.get(raw.kind).push(points.length - 1);
    y += RIVER_ITEM_GAP;
  });

  // 同组相邻两点连一条弧线（控制点朝那一侧推出去，看着像河岸的边）
  const links = [];
  perGroup.forEach((idxs, kind) => {
    const side = GROUP_SIDE[kind] || -1;
    for (let i = 1; i < idxs.length; i += 1) {
      const a = points[idxs[i - 1]];
      const b = points[idxs[i]];
      links.push({
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
        cx: Number((((a.x + b.x) / 2) + side * 14).toFixed(3)),
        cy: Number(((a.y + b.y) / 2).toFixed(3)),
        kind,
      });
    }
  });

  // 主干：中心星连到最近的那一条记忆。没有这一笔，星是星、河是河，两截看着不搭。
  if (points.length) {
    links.push({
      x1: 0,
      y1: 0,
      x2: points[0].x,
      y2: points[0].y,
      cx: Number((points[0].x * 0.35).toFixed(3)),
      cy: Number((points[0].y * 0.55).toFixed(3)),
      kind: 'trunk',
    });
  }

  const groups = RIVER_GROUPS.filter((g) => perGroup.has(g.kind)).map((g) => ({
    kind: g.kind,
    side: g.side,
    count: perGroup.get(g.kind).length,
  }));

  // 横着的那几笔：事件之间的联系（跟时间轴无关）
  const ties = layoutTies(points, kept);
  points.forEach((p, i) => {
    p.tied = ties.filter((t) => t.a === i || t.b === i).map((t) => (t.a === i ? t.b : t.a));
  });

  // 连成一片的，给它们一个名字：这就是「同一件事」
  const clusters = buildClusters(points, kept);
  clusters.forEach((c) => c.members.forEach((i) => { points[i].cluster = c.name; }));

  // 散在事件周围的微星：一条消息一颗。事件星是「事」，这些是「话」——
  // 有了它们画面才有密度，而且每一颗都对应真实的一句，不是拿噪声糊上去的。
  const specks = [];
  for (const raw of raws) {
    if (!raw || !Number.isFinite(raw.at)) continue;
    let best = -1;
    let bestGap = Infinity;
    for (let i = 0; i < points.length; i += 1) {
      const gap = Math.abs(points[i].at - raw.at);
      if (gap < bestGap) { bestGap = gap; best = i; }
    }
    if (best < 0 || bestGap > 45 * 60 * 1000) continue;
    const p = points[best];
    const s1 = hashish(`${raw.ref || raw.at}:sx`);
    const s2 = hashish(`${raw.ref || raw.at}:sy`);
    const ang = s1 * Math.PI * 2;
    const dist = 9 + s2 * 36;
    specks.push({
      x: Number((p.x + Math.cos(ang) * dist).toFixed(2)),
      y: Number((p.y + Math.sin(ang) * dist * 1.12).toFixed(2)),
      r: Number((0.66 + s2 * 0.52).toFixed(2)),
      alpha: Number((0.28 + s1 * 0.3).toFixed(3)),
      kind: raw.kind,
      at: raw.at,
    });
  }

  let minX = 0;
  let maxX = 0;
  points.forEach((p) => {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
  });
  const bottom = n ? points[n - 1].y + RIVER_ITEM_GAP : RIVER_HEAD_GAP;

  return {
    points,
    links,
    ties,
    clusters,
    rulers,
    groups,
    specks,
    center: { x: 0, y: 0 },
    // 给视图算星尘用的：带子的斜度、带心的 y、整条带的高度。
    shear: RIVER_SHEAR,
    midY: Number(midY.toFixed(3)),
    bounds: { minX: minX - 20, maxX: maxX + 20, minY: 0, maxY: bottom },
    height: bottom,
    total,
    shown: n,
    dropped: Math.max(0, total - n),
    now,
  };
}

/**
 * 建竖版时间河。给了 `records` 就纯计算（验算用）；不给就读库。
 * @param {{now?:number, limit?:number, records?:Array}} [opts]
 */
export async function buildRiver({ now = Date.now(), limit = MAX_POINTS, records = null } = {}) {
  const rows = Array.isArray(records) ? records : await loadRecords();
  return layoutRiver(rows, { now, limit });
}

/**
 * 建星图。给了 `records` 就纯计算（验算用）；不给就读库。
 * @param {{weeks?:number, now?:number, records?:Array}} [opts]
 */
export async function buildStarmap({ weeks = 26, now = Date.now(), records = null } = {}) {
  const rows = Array.isArray(records) ? records : await loadRecords();
  return layoutPoints(rows, { weeks, now });
}

/**
 * 某一颗星点了以后看什么：那一天发生的所有事（按时间升序）。
 * @param {string} day 'YYYY-MM-DD'
 * @param {{records?:Array}} [opts]
 */
export async function dayEvents(day, { records = null } = {}) {
  const rows = Array.isArray(records) ? records : await loadRecords();
  const out = [];
  for (const rec of rows || []) {
    const raw = toRaw(rec);
    if (!raw) continue;
    if (dayKey(raw.at) !== day) continue;
    out.push({ kind: raw.kind, at: raw.at, date: day, label: raw.label, hint: raw.hint, ref: raw.ref });
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}

/** 契约名。 */
export const starmapData = buildStarmap;
/** 竖版时间河的别名（视图用这个）。 */
export const riverData = buildRiver;

