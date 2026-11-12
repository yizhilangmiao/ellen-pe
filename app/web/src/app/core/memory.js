// 记忆写入：把聊天里「值得记住的事」抽成 memory 记录。
//
// 为什么要这一层：M0–M7 期间 memory 只能读不能写（全是从旧包导入的），
// 于是「她记得我」这件事其实一直停在新壳装好那一刻。这里补上写路径。
//
// 三条设计约束（都来自老 bug ④ 的教训）：
//   1) 一次只抽 1–3 条，宁可少记也不要把寒暄记成事实；
//   2) 落库前跟已有记忆做重叠比对，>= 0.62 算同一件事，走 revise 不新增，
//      否则聊一周会攒出十几条「豆豆是猫」；
//   3) 模型调用与落库分开：先在内存里把整批算完，再一条一条短事务写。
//
// —— R1（2026-11-13）：记忆对象带状态与来源 ——
//   value.state      active | superseded | retired
//                    active     = 现在算数的说法，会被召回
//                    superseded = 被后来的说法替代（改口/更正），留档、不召回、能点回原话
//                    retired    = 用户说「别再提」，留档、不召回
//   value.supersedes [headId] 这条替代了谁（反向也有 supersededBy）
//   value.reason     为什么翻篇/退役（人读的一句话，不进 prompt）
//   value.sourceRefs [{headId, role, text, at}] 这条记忆是从哪几句来的（R3 点开可看）
//   value.evidenceAt 这条说法的时间（at 是记录时间；编辑后 updatedAt 会变，证据时间不该跟着变）
//
// 判重的口径变了：**按对象实体**，不按字面相似度。原因见下面 ENTITY_STOP 的注释。
import { listLatest } from './store/library.js';
import { invalidateRecall } from './chat/recall.js';
import { appendRecord, reviseRecord } from './store/records.js';
import { ask, stripFence, looseJson } from './chat/oneshot.js';

const PREF_KEY = 'ellen.memory.v1';
export const DEFAULT_MEMORY_PREFS = { auto: true, minMessages: 4, minGapMin: 20, threshold: 0.62 };
const LOOKBACK = 40;
const MAX_ITEMS = 3;

export function readMemoryPrefs() {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    const p = raw ? JSON.parse(raw) : {};
    return {
      auto: p.auto !== false,
      minMessages: clampInt(p.minMessages, DEFAULT_MEMORY_PREFS.minMessages, 2, 30),
      minGapMin: clampInt(p.minGapMin, DEFAULT_MEMORY_PREFS.minGapMin, 5, 240),
      threshold: typeof p.threshold === 'number' ? Math.min(0.9, Math.max(0.4, p.threshold)) : DEFAULT_MEMORY_PREFS.threshold,
    };
  } catch (err) {
    return { ...DEFAULT_MEMORY_PREFS };
  }
}

export function writeMemoryPrefs(patch) {
  const next = { ...readMemoryPrefs(), ...(patch || {}) };
  localStorage.setItem(PREF_KEY, JSON.stringify(next));
  return next;
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/** 中文二元组集合，用来算「是不是同一件事」。跟 recall.js 用的是同一套切法。 */
function bag(text) {
  const out = new Set();
  const src = String(text || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/[，。！？、；：""''（）《》…—·~,.!?;:"'()<>[\]{}/\|@#$%^&*+=_`]/g, ' ');
  for (const part of src.split(' ')) {
    if (!part) continue;
    if (/^[a-z0-9]+$/.test(part)) {
      if (part.length >= 2) out.add(part);
      continue;
    }
    const chars = [...part];
    if (chars.length === 1) out.add(part);
    for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i] + chars[i + 1]);
  }
  return out;
}

export function similarity(a, b) {
  const A = bag(a);
  const B = bag(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const t of A) if (B.has(t)) hit++;
  return hit / Math.min(A.size, B.size);
}

function textOf(item) {
  const v = item && item.value ? item.value : item || {};
  return [v.title, v.summary, v.body, (v.tags || []).join(' ')].filter(Boolean).join(' ');
}

// ——— 判重：按对象实体 ———
//
// 为什么不能再比字面：「以后十点睡」和「以后别熬夜」字面高度相似（共享「以后」），
// 按 0.62 阈值会被判成同一件事，后一条把前一条覆盖掉 —— 用户说了两件事，她只记住一件。
// 「决定 / 改成 / 以后 / 不要 / 别」这类是**指令词**，它们描述「这是一条新说法」，
// 不描述「说的是哪个对象」。所以判重前先把它们剥掉，只拿剩下的实词当实体。
const ENTITY_STOP = [
  '以后', '决定', '改成', '改到', '改为', '已经', '不再', '不要', '别再', '别忘', '忘记',
  '记得', '记住', '想要', '打算', '开始', '坚持', '每天', '每晚', '现在', '最近', '刚才',
  '今天', '昨天', '明天', '后天', '早上', '晚上', '中午', '凌晨', '时候', '事情',
  '这个', '那个', '这样', '那样', '一点', '有点', '真的', '其实', '还是', '就是', '而且',
  '然后', '因为', '所以', '不过', '但是', '如果', '可以', '应该', '需要', '觉得',
  '我要', '我会', '我想', '我不', '我的', '你的', '他的', '她的',
];

/** 剥掉指令词与时间词（长词优先，避免「不要再」被「不要」切一半）。 */
function stripEntityStop(text) {
  let out = String(text || '').toLowerCase();
  for (const w of [...ENTITY_STOP].sort((a, b) => b.length - a.length)) {
    out = out.split(w).join(' ');
  }
  return out;
}

/**
 * 实体词，分两堆：
 *   words     标签 + 正文二元组（判「同一个对象」用）
 *   textWords 只来自标题/正文的二元组（判「真的说的是同一个东西」用）
 * 为什么要分开：标签是**主题**（「作息」这种），正文才是对象（「十点睡」「熬夜」）。
 * 只按标签判，凡属同一主题的全被合并 —— 「以后十点睡」和「以后别熬夜」就是这么被吃掉的。
 */
function entitiesOf(item) {
  const v = item && item.value ? item.value : item || {};
  const words = new Set();
  const textWords = new Set();
  for (const tag of Array.isArray(v.tags) ? v.tags : []) {
    const t = stripEntityStop(tag).replace(/\s+/g, '').trim();
    if (t.length >= 1) words.add(t);
  }
  const src = stripEntityStop([v.title, v.summary, v.body].filter(Boolean).join(' '));
  for (const t of bag(src)) {
    if (t.length >= 2) {
      words.add(t);
      textWords.add(t);
    }
  }
  return { words, textWords };
}

// 同一实体在聊**哪个方面**。同一个实体不同方面是两件事（「猫」的「名字」和「猫」的「过敏」）。
const ASPECTS = [
  ['sleep', ['睡', '熬夜', '起床', '午觉', '午睡', '失眠', '困', '作息', '几点']],
  ['food', ['吃', '喝', '饭', '菜', '辣', '甜', '咖啡', '奶茶', '酒', '香菜', '口味', '忌口', '胃']],
  ['body', ['疼', '痛', '病', '药', '过敏', '体检', '发烧', '感冒', '身高', '体重', '血压', '牙']],
  ['mood', ['累', '烦', '焦虑', '压力', '难过', '开心', '委屈', '生气', 'emo', '情绪']],
  ['pet', ['猫', '狗', '宠物', '养', '豆豆']],
  ['people', ['妈', '爸', '父母', '哥', '姐', '弟', '妹', '朋友', '同事', '老板', '室友', '同学']],
  ['work', ['工作', '上班', '加班', '项目', '客户', '公司', '辞职', '面试', '出差']],
  ['study', ['课', '考', '作业', '学校', '毕业', '论文', '老师', '背书']],
  ['like', ['喜欢', '讨厌', '爱', '不喜欢', '偏好', '最爱']],
  ['plan', ['打算', '计划', '准备', '要买', '存钱', '报名', '约好']],
  ['rel', ['关系', '在一起', '告白', '称呼', '想你', '分手']],
];

function aspectOf(text) {
  const src = String(text || '');
  for (const [id, words] of ASPECTS) {
    if (words.some((w) => src.includes(w))) return id;
  }
  return 'other';
}

/**
 * 是不是同一个实体。三条同时成立才算：
 *   1) 正文里有共同的实体词（只共享标签 = 同一主题，不是同一对象）
 *   2) 说的是同一个方面（「妈妈·回家」和「妈妈·血压」是两件事）
 *   3) 两边都归到 other（没有方面线索）时，要共享两个正文实体词才合并 ——
 *      「今天买了糖」「今天看了电影」共享的只有一个泛词，本该并存。
 */
export function sameEntity(a, b) {
  const A = entitiesOf(a);
  const B = entitiesOf(b);
  if (!A.words.size || !B.words.size) return false;
  const shared = [...A.words].filter((t) => B.words.has(t));
  if (!shared.length) return false;
  const textShared = [...A.textWords].filter((t) => B.textWords.has(t));
  if (!textShared.length) return false;
  const aspectA = aspectOf(textOf(a));
  const aspectB = aspectOf(textOf(b));
  if (aspectA !== aspectB) return false;
  if (aspectA === 'other') return textShared.length >= 2;
  return true;
}

/**
 * 「改口」的相似度下限。
 * 同一个对象、同一个方面，但两句话字面差太远时，更可能是**新的一件事**而不是更正 ——
 * 「豆豆是橘猫」和「豆豆今天打针」不该互相顶掉。所以翻篇要求至少像到 0.34，
 * 低于它的当作并存的一条新事实（宁可多存一条，也不要让旧事被误判成被推翻）。
 */
const SUPERSEDE_MIN = 0.34;

/** 来源引用：只留能看懂的字段，文本截短（原话在消息表里，这里只是索引）。 */
function normRefs(refs) {
  const out = [];
  const seen = new Set();
  for (const r of Array.isArray(refs) ? refs : []) {
    if (!r || !r.headId || seen.has(r.headId)) continue;
    seen.add(r.headId);
    out.push({
      headId: String(r.headId),
      role: r.role === 'assistant' ? 'assistant' : 'user',
      text: String(r.text || '').replace(/\s+/g, ' ').slice(0, 120),
      at: Number(r.at) || 0,
    });
  }
  return out.slice(-6); // 一条记忆最多挂 6 句来源：再多也不是「哪几句」而是全文
}

function readyMessages(messages) {
  return (messages || []).filter(
    (m) => m && !m.pending && !m.failed && typeof m.text === 'string' && m.text.trim() && !/^（/.test(m.text.trim()),
  );
}

/** 该不该现在抽一次：新消息够多 + 距上次够久 + 没在跑。 */
export async function dueFor({ messages, at = Date.now() } = {}) {
  const prefs = readMemoryPrefs();
  if (!prefs.auto) return { due: false, reason: 'off' };
  const rows = await listLatest('memory', { limit: 1 });
  const lastAt = rows.length ? Number(rows[0].value && rows[0].value.at) || rows[0].createdAt || 0 : 0;
  const fresh = readyMessages(messages).filter((m) => (Number(m.createdAt) || 0) > lastAt);
  if (fresh.length < prefs.minMessages) return { due: false, reason: 'tooFew', count: fresh.length };
  if (lastAt && at - lastAt < prefs.minGapMin * 60 * 1000) return { due: false, reason: 'tooSoon' };
  return { due: true, count: fresh.length };
}

const SYSTEM = [
  '你在替「艾莲」整理她愿意记住的事。',
  '只输出 JSON，不要解释：{"memories":[{"title":"不超过 12 字","summary":"一句话，不超过 60 字","scope":"shared"|"past","tags":["短词"]}]}',
  '判断标准：只记「以后还会用到」的——他的喜好、习惯、身体和情绪状态、重要的人和宠物、正在做的事、关系里的变化。',
  '不要记：寒暄、当下这一句的临时情绪、重复说过的话、你自己说的话。',
  'scope：两人共同经历写 shared；关于他本人的事实写 past。',
  // tags 是判重用的实体锚点：写「对象是谁/是什么」，不写「这是一条新决定」。
  'tags：写这件事的对象实体（人、宠物、物、习惯名），例如「豆豆」「猫」「作息」「香菜」；不要写「决定」「以后」「改成」这类指令词。',
  '没有值得记的就输出 {"memories":[]}。最多 3 条。',
].join('\n');

function normItems(raw) {
  const json = looseJson(stripFence(raw)) || {};
  const list = Array.isArray(json.memories) ? json.memories : Array.isArray(json.items) ? json.items : [];
  return list
    .map((it) => {
      if (typeof it === 'string') return { title: it.slice(0, 12), summary: it.slice(0, 60), scope: 'shared', tags: [] };
      const title = String(it.title || it.subject || '').trim().slice(0, 12);
      const summary = String(it.summary || it.body || it.text || '').trim().slice(0, 60);
      if (!title && !summary) return null;
      return {
        title: title || summary.slice(0, 12),
        summary: summary || title,
        scope: it.scope === 'past' ? 'past' : 'shared',
        tags: Array.isArray(it.tags) ? it.tags.map((t) => String(t).slice(0, 8)).slice(0, 4) : [],
      };
    })
    .filter(Boolean)
    .slice(0, MAX_ITEMS);
}

/** 抽一批候选（只调模型，不落库）。 */
export async function compose({ config, messages, at = Date.now() } = {}) {
  const prefs = readMemoryPrefs();
  const existing = await listLatest('memory', { limit: 60 });
  const recent = readyMessages(messages).slice(-LOOKBACK);
  const lines = recent.map((m) => `${m.role === 'user' ? '他' : '我'}：${String(m.text).slice(0, 160)}`);
  const known = existing
    .map((r) => textOf(r))
    .filter(Boolean)
    .slice(0, 30)
    .map((t) => `- ${t.slice(0, 80)}`);
  const prompt = [
    known.length ? `已经记过的（不要重复记）：\n${known.join('\n')}` : '还没有记过任何事。',
    '',
    '最近的对话：',
    lines.join('\n'),
  ].join('\n');
  const raw = await ask({
    config,
    maxTokens: 700,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: prompt },
    ],
  });
  const items = normItems(raw);
  const sourceIds = recent.map((m) => m.headId).filter(Boolean);
  // R1：抽的时候就把「这几句」钉下来 —— 事后从整个对话里反推「这句话是从哪来的」是做不到的，
  // 只有抽取那一刻知道模型看到的是哪 40 句。消息只存索引，原话仍在消息表里。
  const sourceRefs = normRefs(
    recent.map((m) => ({ headId: m.headId, role: m.role, text: m.text, at: m.createdAt })),
  );
  return {
    items: items.map((it) => ({ ...it, at, sourceIds, sourceRefs, threshold: prefs.threshold })),
    raw,
  };
}

function mergeValue(old, item) {
  const v = old && old.value ? old.value : {};
  const body = String(v.body || '');
  const extra = String(item.summary || '');
  const mergedBody = body && extra && !body.includes(extra) ? `${body}\n${extra}` : body || extra;
  return {
    ...v,
    title: v.title || item.title,
    summary: extra.length > String(v.summary || '').length ? extra : v.summary || extra,
    body: mergedBody,
    tags: [...new Set([...(v.tags || []), ...(item.tags || [])])].slice(0, 6),
    scope: v.scope || item.scope,
    at: Number(v.at) || 0,
    updatedAt: item.at,
    sourceIds: [...new Set([...(v.sourceIds || []), ...(item.sourceIds || [])])].slice(-20),
    // 补进来的是同一个说法的另一句原话：来源累加，证据时间取最早那次（这条事实从那时起就成立）
    sourceRefs: normRefs([...(v.sourceRefs || []), ...(item.sourceRefs || [])]),
    evidenceAt: Number(v.evidenceAt) || Number(v.at) || item.at,
    state: v.state || 'active',
    editedBy: 'ellen',
  };
}

/** 新记一条时的 value（R1 字段一次给全，老包读到的 value 没有这些字段也照常当 active）。 */
function newValue(item, at, extra = {}) {
  return {
    title: item.title,
    summary: item.summary,
    body: item.summary,
    tags: item.tags || [],
    scope: item.scope || 'shared',
    at,
    createdAt: at,
    updatedAt: at,
    sourceIds: item.sourceIds || [],
    sourceRefs: normRefs(item.sourceRefs || []),
    state: 'active',
    supersedes: [],
    evidenceAt: at,
    editedBy: 'ellen',
    ...extra,
  };
}

/**
 * 落库：按**对象实体**判重，三种走向 ——
 *   repeat    同一实体 + 说法几乎一致（sim >= 阈值）→ 并进那条，只加来源，不另起一条
 *   revise    同一实体 + 说法是补充（sim >= 阈值）→ 改那条（老路子）
 *   supersede 同一实体 + 说法不同但还认得出是同一件事（SUPERSEDE_MIN <= sim < 阈值）
 *             → 新说法立一条 active，旧条目标 superseded（不删，能点回原话）
 * 其余都是新的一件事，直接新增。只有 active 的条目能吸收新说法 ——
 * 已翻篇/已退役的不再被改写，否则「别再提」会被下一轮对话复活。
 */
export async function write(items, at = Date.now()) {
  const existing = await listLatest('memory', { limit: 80 });
  const threshold = readMemoryPrefs().threshold;
  const out = { added: 0, revised: 0, superseded: 0, skipped: 0, items: [] };
  for (const item of items || []) {
    const text = `${item.title} ${item.summary}`;
    let pick = null;
    for (const row of existing) {
      const v = row.value || {};
      if (v.state && v.state !== 'active') continue; // 翻篇/退役的不吸收
      const same = sameEntity(row, item);
      const sim = similarity(text, textOf(row));
      // 排序键：实体命中压过字面相似（同一对象的两种说法，字面往往只像一半）
      const rank = (same ? 100 : 0) + sim;
      if (!pick || rank > pick.rank) pick = { row, same, sim, rank };
    }
    const hit = pick && (pick.same || pick.sim >= threshold) ? pick : null;

    // 同一实体、说法够像 → 并进原来那条（repeat / revise）
    if (hit && hit.sim >= threshold) {
      await reviseRecord(hit.row.headId, mergeValue(hit.row, item));
      out.revised += 1;
      out.items.push({
        action: hit.same ? 'repeat' : 'revise',
        headId: hit.row.headId,
        score: Number(hit.sim.toFixed(3)),
        title: item.title,
      });
      continue;
    }

    // 同一实体、说法不像但还看得出是同一件事 → 视为改口：新的生效，旧的留档
    if (hit && hit.same && hit.sim >= SUPERSEDE_MIN) {
      const value = newValue(item, at, { supersedes: [hit.row.headId] });
      const rec = await appendRecord({ kind: 'memory', value, at });
      const oldValue = hit.row.value || {};
      await reviseRecord(hit.row.headId, {
        ...oldValue,
        state: 'superseded',
        supersededBy: rec.headId,
        reason: `说法变了：${String(item.summary || '').slice(0, 40)}`,
        updatedAt: at,
      });
      out.added += 1;
      out.superseded += 1;
      out.items.push({ action: 'supersede', headId: rec.headId, from: hit.row.headId, title: item.title });
      existing.unshift({ headId: rec.headId, kind: 'memory', value });
      continue;
    }

    // 剩下的都是新的一件事（包括「同一个对象但完全在说别的」）
    const value = newValue(item, at);
    const rec = await appendRecord({ kind: 'memory', value, at });
    out.added += 1;
    out.items.push({ action: 'add', headId: rec.headId, title: item.title });
    existing.unshift({ headId: rec.headId, kind: 'memory', value });
  }
  // 记忆变了，召回索引要重建（否则「刚记下的事」要等 5 分钟缓存过期才召回得到）
  if (out.added || out.revised || out.superseded) invalidateRecall();
  if (out.added) await pruneMemory({ at });
  return out;
}

/** 拿一条记忆当前 value（UI 与验收都要看 state/sourceRefs）。 */
export async function getMemory(headId) {
  const rows = await listLatest('memory', { limit: 0 });
  return rows.find((r) => r.headId === headId) || null;
}

let running = false;
export function isRunning() {
  return running;
}

export async function maybeRemember({ config, messages, at = Date.now() } = {}) {
  if (running) return { skipped: 'running' };
  const gate = await dueFor({ messages, at });
  if (!gate.due) return { skipped: gate.reason, count: gate.count };
  running = true;
  try {
    const { items } = await compose({ config, messages, at });
    if (!items.length) return { skipped: 'nothing', items: [] };
    const res = await write(items, at);
    return { ok: true, ...res };
  } finally {
    running = false;
  }
}

/** 验收/界面用：不看门槛直接抽一次。 */
export async function rememberNow({ config, messages, at = Date.now() } = {}) {
  const { items, raw } = await compose({ config, messages, at });
  const res = await write(items, at);
  return { ...res, candidates: items.length, raw: raw ? String(raw).slice(0, 400) : '' };
}

// —— 人工入口（改 / 删 / 手记一条）——
// 自动抽出来的东西一定有错的时候，界面上得能改。
// 删走软删（reviseRecord 的 deleted:true），不做物理删除：手记/记忆都是事件溯源结构，
// 物理删会让「这一条曾被记过」这件事消失，日后回溯不了。

function cleanText(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function normTags(tags) {
  const list = Array.isArray(tags) ? tags : String(tags || '').split(/[，,、\s]+/);
  return list.map((t) => cleanText(t, 8)).filter(Boolean).slice(0, 4);
}

/** 手记一条（用户自己写）。返回 {headId, value}。 */
export async function createMemory({ title, summary, tags, scope = 'shared', at = Date.now() } = {}) {
  const t = cleanText(title, 12);
  const s = cleanText(summary, 120);
  if (!t && !s) {
    const err = new Error('标题和内容都空着');
    err.code = 'MEMORY_EMPTY';
    throw err;
  }
  const value = {
    namespace: 'ellen.memory',
    version: 1,
    title: t || s.slice(0, 12),
    summary: s || t,
    body: s || t,
    tags: normTags(tags),
    scope: scope === 'past' ? 'past' : 'shared',
    at,
    createdAt: at,
    updatedAt: at,
    sourceIds: [],
    // 手记的没有「哪几句」这回事：来源就写「他自己写的」，R3 点开时照实说
    sourceRefs: [{ headId: '', role: 'user', text: '（他自己手记的）', at }],
    state: 'active',
    supersedes: [],
    evidenceAt: at,
    editedBy: 'user',
  };
  const res = await appendRecord({ kind: 'memory', value });
  invalidateRecall();
  return { ...res, value };
}

/** 改一条：patch 里只带要动的字段，其余保持原样。 */
export async function updateMemory(headId, patch = {}, at = Date.now()) {
  const rows = await listLatest('memory', { limit: 0 });
  const row = rows.find((r) => r.headId === headId);
  if (!row) {
    const err = new Error('这条记忆已经不在了');
    err.code = 'MEMORY_MISSING';
    throw err;
  }
  const old = row.value || {};
  const title = patch.title === undefined ? old.title : cleanText(patch.title, 12);
  const summary = patch.summary === undefined ? old.summary : cleanText(patch.summary, 120);
  if (!title && !summary) {
    const err = new Error('标题和内容都空着');
    err.code = 'MEMORY_EMPTY';
    throw err;
  }
  const value = {
    ...old,
    title: title || summary.slice(0, 12),
    summary: summary || title,
    body: summary || title,
    tags: patch.tags === undefined ? normTags(old.tags) : normTags(patch.tags),
    scope: patch.scope === undefined ? old.scope || 'shared' : patch.scope === 'past' ? 'past' : 'shared',
    updatedAt: at,
    editedBy: 'user',
  };
  const res = await reviseRecord(headId, value, { at });
  invalidateRecall();
  return { ...res, value };
}

/** 删一条（软删，列表里不再出现）。 */
export async function removeMemory(headId, at = Date.now()) {
  const rows = await listLatest('memory', { limit: 0 });
  const row = rows.find((r) => r.headId === headId);
  if (!row) {
    const err = new Error('这条记忆已经不在了');
    err.code = 'MEMORY_MISSING';
    throw err;
  }
  const res = await reviseRecord(headId, row.value || {}, { at, deleted: true });
  invalidateRecall();
  return { ...res, title: (row.value || {}).title || '' };
}

// ——— R1：状态流转 ———
//
// 「别再提」跟「删掉」不是一回事：删掉她连「这件事聊过」都不知道了，
// 下次又会被同一句话重新记一遍；退役是「知道但不说」，所以要留档、要能恢复。
export const MEMORY_STATES = ['active', 'superseded', 'retired'];

/** 标记「别再提」：留档、不召回。 */
export async function retireMemory(headId, reason = 'user', at = Date.now()) {
  const rows = await listLatest('memory', { limit: 0 });
  const row = rows.find((r) => r.headId === headId);
  if (!row) {
    const err = new Error('这条记忆已经不在了');
    err.code = 'MEMORY_MISSING';
    throw err;
  }
  const value = {
    ...(row.value || {}),
    state: 'retired',
    reason: reason === 'user' ? '他说别再提了' : String(reason || ''),
    retiredAt: at,
    updatedAt: at,
  };
  const res = await reviseRecord(headId, value, { at });
  invalidateRecall();
  return { ...res, value };
}

/** 恢复：退役/翻篇的条目回到 active。 */
export async function restoreMemory(headId, at = Date.now()) {
  const rows = await listLatest('memory', { limit: 0 });
  const row = rows.find((r) => r.headId === headId);
  if (!row) {
    const err = new Error('这条记忆已经不在了');
    err.code = 'MEMORY_MISSING';
    throw err;
  }
  const value = { ...(row.value || {}), state: 'active', reason: '', updatedAt: at };
  const res = await reviseRecord(headId, value, { at });
  invalidateRecall();
  return { ...res, value };
}

/**
 * 容量：退役不删，只清最旧的**非活动**记录。
 * 触发条件是「非活动条数 > active × factor」—— 留档是为了能点回去看，
 * 但留到四倍还没清，就变成拿存储换一个没人翻的坟场。
 * records 没有物理删除 API，用软删（deleted:true）实现，语义上等价于「连留档都不要了」。
 */
export async function pruneMemory({ factor = 4, at = Date.now() } = {}) {
  const rows = await listLatest('memory', { limit: 0 });
  const active = rows.filter((r) => !r.value || !r.value.state || r.value.state === 'active');
  const cold = rows
    .filter((r) => r.value && r.value.state && r.value.state !== 'active')
    .sort((a, b) => (Number(b.value.updatedAt) || b.at || 0) - (Number(a.value.updatedAt) || a.at || 0));
  const budget = Math.max(1, active.length * factor);
  if (cold.length <= budget) return { removed: 0, cold: cold.length, budget };
  // cold 是「新 → 旧」，要从尾巴开始删
  const doomed = cold.slice(budget);
  for (const row of doomed) await reviseRecord(row.headId, row.value, { at, deleted: true });
  if (doomed.length) invalidateRecall();
  return { removed: doomed.length, cold: cold.length, budget };
}

/** 按状态分组取（记忆页要同时显示在用/已翻篇，UI 不该自己 filter 三遍）。 */
export function splitByState(rows) {
  const out = { active: [], superseded: [], retired: [] };
  for (const r of rows || []) {
    const st = (r.value && r.value.state) || 'active';
    (out[st] || out.active).push(r);
  }
  return out;
}
