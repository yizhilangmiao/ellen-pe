// 三层 lore 加载：常驻事实 + 世界书关键词命中 + 口吻随机样本。
//
// 为什么要有这个模块：
//   电脑版把整张角色卡（212 KB 恋人卡 / 7 KB 核心档案）一次性塞进 system prompt，那在电脑上付得起；
//   手机版每条消息都要走云 API，prompt 长度直接换算成钱和首字延迟，所以必须做「按需取用」。
//   老大拍板的是「移植同一套设定」，不是「按手机重写一版人设」——所以数据仍来自电脑版素材，
//   只是取用策略换成三层。
//
// 为什么不能运行时 fetch：App 走 file:///android_asset/，WebView 会拦 XHR/fetch；
//   数据只以 ES 模块形式随 vite 打进 bundle，运行时零 IO。
//
// 硬指标：buildLoreBlock() 的返回值 ≤ LORE_MAX_BYTES(3 KB)。超了先丢样本、再丢第二条世界书、
//   再丢世界设定，最后才硬截断——常驻事实永远保住。
import { CARD_IDS, DEFAULT_CARD_ID, cardOf } from '../assets/lore/index.js';

const KEY = 'ellen.lore.v1';

/** lore 段字节上限。3 KB × 每条消息 = 每天几千次，不是小事。 */
export const LORE_MAX_BYTES = 3072;

/** 每条世界书正文最多留多少字（再长也是从同一段里截，模型读不完）。 */
const WB_MAX_CHARS = 110;

/** 一次最多命中几条世界书：两条已经是 220 字，再多就把常驻事实挤出去。 */
const WB_LIMIT = 2;

/** 口吻样本最长多少字（样本是用来定语感的，不是用来讲故事的）。 */
const SAMPLE_MAX_CHARS = 26;

function byteLength(text) {
  return new TextEncoder().encode(String(text || '')).length;
}

/** 按句末断字，找不到句末就硬切——截断处不能是一个断句。 */
function clip(text, max) {
  const str = String(text || '').replace(/\s+/g, ' ').trim();
  if (str.length <= max) return str;
  const head = str.slice(0, max);
  const cut = Math.max(
    head.lastIndexOf('。'),
    head.lastIndexOf('；'),
    head.lastIndexOf('！'),
    head.lastIndexOf('？'),
    head.lastIndexOf('｜'),
  );
  const kept = cut > max * 0.5 ? head.slice(0, cut + 1) : head;
  // 截断后别留一个光秃秃的「｜」「；」在句尾，读着像话没说完
  return kept.replace(/[｜；、，]+$/, '');
}

// ——— 世界书索引：模块顶层建一次 ———
// 为什么在顶层：buildSystemPrompt 是热路径（每次发送都调）。34 条 × 十来个关键词逐条扫是白烧 CPU，
// 建一次倒排表（关键词 → 条目）之后，命中只看用户那句话里包含哪些键。
// 键按数组实例缓存：两张卡共用同一份世界书时只建一次索引，将来换角色也不会互串。
const BOOK_INDEX = new Map();

function indexOfBook(book) {
  const list = Array.isArray(book) ? book : [];
  let index = BOOK_INDEX.get(list);
  if (index) return index;
  index = new Map();
  for (const entry of list) {
    const keys = Array.isArray(entry && entry.keys) ? entry.keys : [];
    for (const raw of keys) {
      const key = String(raw || '').trim().toLowerCase();
      if (!key) continue;
      const bucket = index.get(key);
      if (bucket) bucket.push(entry);
      else index.set(key, [entry]);
    }
  }
  BOOK_INDEX.set(list, index);
  return index;
}

/** 预热索引（设置页切换角色卡时调一次，避免第一次发送才建表）。 */
export function warmLore(cardId) {
  const card = cardOf(cardId || readCardId());
  indexOfBook(card.worldbook);
  return card.id;
}

/**
 * 世界书关键词命中——不是随机抽。
 * 打分：命中键越多越靠前；同分时长键优先（「看电影」比「电影」更具体）；
 * 再同分按原书顺序（anchor 在 memory 前，锚点比回忆更贴当下）。
 * 完全没命中就返回空——宁可少一段，也不要塞一条和这句话无关的设定。
 */
export function matchWorldbook(card, query, limit = WB_LIMIT) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const index = indexOfBook(card && card.worldbook);
  const scored = new Map(); // entry -> { hits, long }
  for (const key of index.keys()) {
    if (!q.includes(key)) continue;
    for (const entry of index.get(key)) {
      const cur = scored.get(entry) || { hits: 0, long: 0 };
      cur.hits += 1;
      cur.long = Math.max(cur.long, key.length);
      scored.set(entry, cur);
    }
  }
  const picked = [...scored.entries()]
    .sort((a, b) => b[1].hits - a[1].hits || b[1].long - a[1].long)
    .map(([entry]) => entry);
  // 同一段经历在世界书里既有 anchor 又有 memory（内容几乎一样），去重避免两条说同一件事
  const out = [];
  const seen = new Set();
  for (const entry of picked) {
    const sig = String(entry.x || '').slice(0, 24);
    if (sig && seen.has(sig)) continue;
    if (sig) seen.add(sig);
    out.push(entry);
    if (out.length >= limit) break;
  }
  return out;
}

/** 随机 2~3 条口吻样本；rand 可注入，验收脚本要可复现。 */
export function pickSamples(card, rand = Math.random) {
  const list = (card && Array.isArray(card.samples) ? card.samples : []).filter((s) => s && s.l);
  if (!list.length) return [];
  const want = Math.min(list.length, rand() < 0.5 ? 2 : 3);
  const pool = list.slice();
  const out = [];
  for (let i = 0; i < want; i += 1) {
    const at = Math.floor(rand() * pool.length) % pool.length;
    out.push(clip(pool[at].l, SAMPLE_MAX_CHARS));
    pool.splice(at, 1);
  }
  return out;
}

/**
 * 原作记忆：接口先留，不做召回。
 * 为什么先留空：原作记忆 77.5 KB（30 条 summary + 一堆语音来源噪音 + sources 里 ~90 个巨型键），
 * 真接进来必须配向量或分词召回，那是下一轮的事；现在只要接口形状定下来，
 * 上层（buildLoreBlock 之外的调用方）不用改签名。
 * 将来实现时只读 assets/lore/ellen-memory.js 的 entries，按 query 命中 title/aliases/summary。
 */
export function recallMemory(/* cardId, query, { now = Date.now() } = {} */) {
  return [];
}

/** 选中的角色卡 id；存储结构留成对象，将来加字段（比如卡内开关）不用换 key。 */
export function readCardId() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_CARD_ID;
    const parsed = JSON.parse(raw);
    const id = parsed && parsed.cardId;
    return CARD_IDS.includes(id) ? id : DEFAULT_CARD_ID;
  } catch {
    return DEFAULT_CARD_ID;
  }
}

/** 切卡；认不出来的 id 不写进去（避免包一层脏数据让下次启动回落到默认卡还以为是用户选的）。 */
export function writeCardId(id) {
  if (!CARD_IDS.includes(id)) return readCardId();
  try {
    localStorage.setItem(KEY, JSON.stringify({ cardId: id }));
  } catch {
    /* 隐私模式下写不进 localStorage 就当没切，下次仍是默认卡 */
  }
  return id;
}

/** 导出资料包时要带走的角色卡选择。 */
export function readLoreSelection() {
  return { cardId: readCardId() };
}

/**
 * 导入时把包里的角色卡选择写回本地。
 * 只在用户确认导入之后调用（page-backup 的确认框之后），否则等于替用户改了人设。
 */
export function applyLoreSelection(lore) {
  const id = lore && typeof lore === 'object' ? lore.cardId : null;
  if (!CARD_IDS.includes(id)) return readCardId();
  return writeCardId(id);
}

/** 当前卡的一句话说明，给设置页用。 */
export function describeCard(id) {
  const card = cardOf(id);
  return { id: card.id, label: card.label, tag: card.tag, summary: card.summary };
}

/** 卡名（资料包提示要用）；不认识的 id 回落到默认卡的名字。 */
export function cardLabel(id) {
  return cardOf(id).label;
}

/** 这个 id 本机认不认得（导入别人新版本的包时可能带来本机没有的卡）。 */
export function isKnownCard(id) {
  return CARD_IDS.includes(id);
}

/**
 * 组 lore 段。
 *
 * @param {object} opts
 * @param {object} [opts.persona]    只用于读用户补充设定（note 不长，但优先级排在世界书之上）
 * @param {object} [opts.relationship]
 * @param {string} [opts.query]      用户这一句原话，世界书按它命中
 * @param {number} [opts.now]        预留：原作记忆按时间衰减时用；当前不参与拼接
 * @param {Function} [opts.rand]     随机源，验收可注入
 * @param {string} [opts.cardId]     显式指定角色卡（设置页预览用）
 * @returns {string} ≤ LORE_MAX_BYTES 的中文段落；没有可用内容时返回 ''
 */
export function buildLoreBlock({
  persona, relationship, query = '', now = Date.now(), rand = Math.random, cardId,
} = {}) {
  // now / relationship 当前不参与拼接：时段语气和关系档的措辞归 persona.js，
  // 这里只提供事实，两个模块同时改语气会互相打架。参数保留是为了签名稳定。
  void relationship; void now;

  const card = cardOf(cardId || readCardId());
  const segs = [];
  segs.push({ k: 'head', t: `【角色卡·${card.label}｜${card.tag}】` });
  (card.core || []).forEach((line, i) => segs.push({ k: `core${i}`, t: line }));

  // 用户自己写的补充设定：优先级高于世界书（那是他自己说的，比资料更像事实）
  const note = clip(String((persona && persona.note) || '').trim(), 160);
  if (note) segs.push({ k: 'note', t: `他的补充设定：${note}` });

  const world = Array.isArray(card.world) ? card.world.join('') : '';
  if (world) segs.push({ k: 'world', t: `世界：${world}` });

  const hits = matchWorldbook(card, query, WB_LIMIT);
  hits.forEach((entry, i) => {
    segs.push({ k: `wb${i}`, t: `背景·${entry.t}：${clip(entry.x, WB_MAX_CHARS)}` });
  });

  const samples = pickSamples(card, rand);
  if (samples.length) segs.push({ k: 'smp', t: `口吻参考（别照抄，只借语感）：${samples.join(' / ')}` });

  // 超预算时的丢弃顺序：样本 → 第二条世界书 → 世界设定 → 第一条世界书。
  // 常驻事实（head/core/note）永不丢：它们是这张卡的底。
  const dropOrder = ['smp', 'wb1', 'world', 'wb0'];
  let list = segs;
  for (const k of dropOrder) {
    if (byteLength(list.map((s) => s.t).join('\n')) <= LORE_MAX_BYTES) break;
    list = list.filter((s) => s.k !== k);
  }
  let text = list.map((s) => s.t).join('\n');

  // 兜底：常驻段本身超限（用户 note 写爆）时按字节硬截，保证硬指标不破。
  if (byteLength(text) > LORE_MAX_BYTES) {
    let acc = '';
    for (const ch of text) {
      if (byteLength(acc + ch) > LORE_MAX_BYTES - 3) break;
      acc += ch;
    }
    text = `${acc}…`;
  }
  return text;
}

/** 设置页/验收脚本用：这段 lore 现在多重、命中了几条。 */
export function loreStats({ cardId, query = '', rand = Math.random, persona } = {}) {
  const id = cardId || readCardId();
  const card = cardOf(id);
  const text = buildLoreBlock({ cardId: id, query, rand, persona });
  return {
    cardId: card.id,
    label: card.label,
    bytes: byteLength(text),
    limit: LORE_MAX_BYTES,
    hits: matchWorldbook(card, query, WB_LIMIT).map((e) => e.t),
    samples: (card.samples || []).length,
    worldbook: (card.worldbook || []).length,
    text,
  };
}

/** 所有可选卡（设置页列表用），顺序即展示顺序。 */
export function listCards() {
  // 传 id 而不是卡对象：describeCard 走 cardOf() 做 id 归一，塞对象进去会一律回落成默认卡
  return CARD_IDS.map((id) => describeCard(id));
}
