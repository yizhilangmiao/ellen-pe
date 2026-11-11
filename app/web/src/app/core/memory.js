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
  return { items: items.map((it) => ({ ...it, at, sourceIds, threshold: prefs.threshold })), raw };
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
    editedBy: 'ellen',
  };
}

/** 落库：重叠够高的改旧的那条，其余新增。返回 {added, revised, skipped}。 */
export async function write(items, at = Date.now()) {
  const existing = await listLatest('memory', { limit: 80 });
  const out = { added: 0, revised: 0, skipped: 0, items: [] };
  for (const item of items || []) {
    const text = `${item.title} ${item.summary}`;
    let best = null;
    let bestScore = 0;
    for (const row of existing) {
      const score = similarity(text, textOf(row));
      if (score > bestScore) {
        bestScore = score;
        best = row;
      }
    }
    if (best && bestScore >= (item.threshold || readMemoryPrefs().threshold)) {
      await reviseRecord(best.headId, mergeValue(best, item));
      out.revised += 1;
      out.items.push({ action: 'revise', headId: best.headId, score: Number(bestScore.toFixed(3)), title: item.title });
      continue;
    }
    const value = {
      title: item.title,
      summary: item.summary,
      body: item.summary,
      tags: item.tags || [],
      scope: item.scope || 'shared',
      at,
      createdAt: at,
      updatedAt: at,
      sourceIds: item.sourceIds || [],
      editedBy: 'ellen',
    };
    const rec = await appendRecord({ kind: 'memory', value, at });
    out.added += 1;
    out.items.push({ action: 'add', headId: rec.headId, title: item.title });
    existing.unshift({ headId: rec.headId, kind: 'memory', value });
  }
  // 记忆变了，召回索引要重建（否则「刚记下的事」要等 5 分钟缓存过期才召回得到）
  if (out.added || out.revised) invalidateRecall();
  return out;
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
