// 手记：把一天的对话，收成她自己的一篇日记。
//
// 为什么叫「手记」不叫「日志」：旧包字段就叫 journal，界面文案是「她写给你的手记」，
// 数据字段沿用旧包的名字（`day` / `title` / `diary` / `thoughts` / `understanding`），
// 这样旧资料包导进来能直接读，新写的也能被将来的迁移认出来。
//
// 三个必须守住的点：
//  1. **一天一篇**：`day` 是主键语义，同一天再写就 revise 那一篇，不新开。
//  2. **思考要关**：后台加工用 `thinking:{type:'disabled'}`（老 bug ⑩：开着思考会拖到超时）。
//  3. **落库要短**：模型调用可能几十秒，但写完只做一次短事务（老 bug ①：旧包 30 s 事务被掐断）。
import { ask, looseJson } from './chat/oneshot.js';
import { appendRecord, reviseRecord } from './store/records.js';
import { listLatest } from './store/library.js';
import { invalidateRecall } from './chat/recall.js';

const NS = 'ellen.journal';
const VERSION = 1;
const MIN_MESSAGES = 3; // 少于这个数不值得写一篇
const MIN_GAP_MS = 4 * 60 * 60 * 1000; // 同一篇隔 4 小时才补写
const LOOKBACK = 40; // 最多取最近多少条对话当素材

// —— 手记整理的开关 ——
// 默认全开：老大要的第一版必含项就是「手记整理」，装完就该自己会写。
// 关掉之后 maybeCompose 直接返回，其他调用点不用各改一遍。
const PREF_KEY = 'ellen.journal.v1';
export const DEFAULT_JOURNAL_PREFS = { auto: true, minMessages: MIN_MESSAGES, minGapHours: 4 };

export function readJournalPrefs() {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return { ...DEFAULT_JOURNAL_PREFS };
    const parsed = JSON.parse(raw);
    const merged = { ...DEFAULT_JOURNAL_PREFS, ...parsed };
    merged.auto = !!merged.auto;
    const mm = Number(merged.minMessages);
    merged.minMessages = Number.isFinite(mm) ? Math.min(20, Math.max(2, Math.round(mm))) : MIN_MESSAGES;
    const gap = Number(merged.minGapHours);
    merged.minGapHours = Number.isFinite(gap) ? Math.min(24, Math.max(1, Math.round(gap))) : 4;
    return merged;
  } catch {
    return { ...DEFAULT_JOURNAL_PREFS };
  }
}

export function writeJournalPrefs(patch) {
  const merged = { ...readJournalPrefs(), ...patch };
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(merged));
  } catch (err) {
    console.warn('[journal] 偏好存不下', err);
  }
  return merged;
}

/** 本地日：`2026-11-04`。手记按设备本地日切，不按 UTC（否则凌晨会写到前一天）。 */
export function dayKey(at = Date.now()) {
  const d = new Date(at);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function timeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
  } catch {
    return 'Asia/Shanghai';
  }
}

/** 读今天那篇（没有就返回 null）。 */
export async function todayJournal(at = Date.now()) {
  const day = dayKey(at);
  // 先只取最近 60 篇（快）；取不到再全量兜一次。
  // 为什么要有兜底：手记没有「按 day 查」的索引，只能按时间排序后截断，
  // 一旦库里手记超过 60 篇（写满两个月就到），今天那篇可能落在截断之外，
  // 于是显示成「今天还没写」→ 又新开一篇，一天两篇（压测 502 篇时踩到）。
  const rows = await listLatest('journal', { limit: 60 });
  let hit = rows.find((r) => (r.value && r.value.day) === day);
  if (!hit) {
    const all = await listLatest('journal', { limit: 0 });
    hit = all.find((r) => (r.value && r.value.day) === day);
  }
  return hit || null;
}

/**
 * 现在该不该写一篇？
 * 判据：距离上一篇（或今天零点）之后，够 MIN_MESSAGES 条对话，且距上次写入超过 MIN_GAP_MS。
 */
export async function dueFor({ messages = [], at = Date.now() } = {}) {
  const prefs = readJournalPrefs();
  const minGapMs = prefs.minGapHours * 60 * 60 * 1000;
  const day = dayKey(at);
  const existing = await todayJournal(at);
  const since = existing && existing.at ? Math.max(Number(existing.at) || 0, 0) : startOfDay(at);

  const fresh = messages.filter((m) => {
    if (!m || m.pending || m.failed) return false;
    const t = Number(m.createdAt) || 0;
    return t > since && !String(m.text || '').startsWith('（');
  });

  if (existing && at - (Number(existing.at) || 0) < minGapMs) {
    return { due: false, reason: 'tooSoon', count: fresh.length, day };
  }
  if (fresh.length < prefs.minMessages) {
    return { due: false, reason: 'tooFew', count: fresh.length, day };
  }
  return { due: true, day, count: fresh.length, messages: fresh.slice(-LOOKBACK) };
}

function startOfDay(at) {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function transcript(messages) {
  return messages
    .map((m) => (m.role === 'user' ? `他：${oneLine(m.text)}` : `我：${oneLine(m.text)}`))
    .join('\n');
}

function oneLine(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

const SYSTEM = [
  '你在写自己的手记——不是写给他的信，是写给自己看的日记。',
  '用第一人称，语气像平时说话那样，可以有点碎、有点走神，但不要客套。',
  '写完只输出一个 JSON 对象，不要别的东西，格式：',
  '{"title": "最多 12 个字的小标题", "diary": "正文，2 到 4 段，用 \\n 分段", "thoughts": "一句话，写完的感受"}',
  '不要总结成"今天我们聊了……"，那是流水账。挑一两个让你记住的瞬间写。',
].join('\n');

/**
 * 让模型把对话收成一篇。
 * @returns {Promise<{title:string, diary:string, thoughts:string}>}
 */
export async function compose({ config, messages, previous = null, at = Date.now() }) {
  const day = dayKey(at);
  const prevHint = previous && previous.value
    ? `\n（上一段手记是 ${previous.value.day} 写的，结尾是：「${oneLine(previous.value.diary).slice(-60)}」。如果要接着写，别重复它。）`
    : '';

  const user = [
    `今天是 ${day}。`,
    '',
    '下面是最近聊的：',
    transcript(messages),
    prevHint,
    '',
    '写今天这一篇。',
  ].join('\n');

  const raw = await ask({
    config,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: user },
    ],
    disableThinking: true,
    maxTokens: 900,
  });

  const parsed = looseJson(raw);
  if (parsed && (parsed.diary || parsed.title)) {
    return {
      title: String(parsed.title || '').trim().slice(0, 24) || `${day} 这天`,
      diary: String(parsed.diary || '').trim(),
      thoughts: String(parsed.thoughts || '').trim(),
    };
  }

  // 模型没照格式写：整段当正文，标题取第一句前 12 字，别丢内容
  const text = String(raw || '').trim();
  if (!text) throw Object.assign(new Error('模型没有返回内容'), { code: 'EMPTY_CONTENT' });
  const firstLine = text.split('\n').find((l) => l.trim()) || text;
  return { title: firstLine.trim().slice(0, 12), diary: text, thoughts: '' };
}

/**
 * 写进库：今天已有就追加一条 revision，没有就新建。
 * @returns {Promise<{headId:string, day:string, revised:boolean}>}
 */
export async function writeJournal({ title, diary, thoughts = '', day = dayKey(), sourceIds = [], at = Date.now() }) {
  const existing = await todayJournal(at);
  const now = new Date(at).toISOString();

  if (existing) {
    // listLatest 回的 value 已经是这条 head 的最新 revision，直接拿来当基线
    const base = existing.value || {};
    const value = {
      ...base,
      day,
      timeZone: timeZone(),
      title,
      diary,
      thoughts,
      updatedAt: now,
      editedBy: 'ellen',
      sourceIds: mergeIds(base.sourceIds, sourceIds),
      retained: true,
    };
    const rev = await reviseRecord(existing.headId, value, { at });
    return { headId: existing.headId, revisionId: rev && rev.revisionId, day, revised: true };
  }

  const value = {
    namespace: NS,
    version: VERSION,
    scope: 'main',
    day,
    timeZone: timeZone(),
    title,
    diary,
    thoughts,
    sourceIds: Array.isArray(sourceIds) ? sourceIds.slice() : [],
    processedIds: [],
    understanding: { body: '', sourceIds: [], processedIds: [], updatedAt: null },
    retained: true,
    createdAt: now,
    updatedAt: now,
    editedBy: 'ellen',
  };
  // 手记是全局的（不挂在某个会话线程下），threadId 传 null
  const rec = await appendRecord({ kind: 'journal', value, threadId: null, at });
  return { headId: rec.headId, revisionId: rec.revisionId, day, revised: false };
  invalidateRecall();
}

function mergeIds(a, b) {
  const out = new Set([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]);
  return [...out];
}

let running = false;

/**
 * 一次完整的「该写吗 → 写 → 落库」。
 * 并发保护：正在写就直接返回 running，避免同一天连开两篇。
 */
export async function maybeCompose({ config, messages, at = Date.now() }) {
  if (running) return { skipped: 'running' };
  if (!config || !config.apiKey) return { skipped: 'noConfig' };
  if (!readJournalPrefs().auto) return { skipped: 'off' };

  let gate;
  try {
    gate = await dueFor({ messages, at });
  } catch (err) {
    console.warn('[journal] 判断是否该写失败', err);
    return { skipped: 'gateError' };
  }
  if (!gate.due) return { skipped: gate.reason, count: gate.count };

  running = true;
  try {
    const previous = await todayJournal(at - 86400000);
    const entry = await compose({ config, messages: gate.messages, previous, at });
    const res = await writeJournal({ ...entry, day: gate.day, at });
    return { ...res, title: entry.title };
  } finally {
    running = false;
  }
}

export function isRunning() {
  return running;
}
