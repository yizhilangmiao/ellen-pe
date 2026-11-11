// 「我眼里的你」：把攒下来的记忆与手记，压成一段第二人称的描述。
//
// 为什么单独一层：`core/journal.js` 里那个 `understanding` 字段一直写的是空对象，
// 记忆页的「我眼里的你」因此只能摆一个空盒。这里补上真正的读写路径。
//
// 三条约束（照 memory.js 的老 bug ① 教训）：
//   1) 模型调用与落库分开：compose() 只把结果算在内存里，写库是 writeUnderstanding() 的事；
//   2) 失败只 warn，不抛给界面 —— 攒不够就说攒不够，不能把回忆页整页带崩；
//   3) 不是每次进页面都调模型：记忆有更新、且距上次写过 > 24h 才跑（force 可越过）。
import { listLatest } from './store/library.js';
import { appendRecord } from './store/records.js';
import { ask, stripFence, looseJson } from './chat/oneshot.js';

const KIND = 'understanding';
/** 隔多久才值得重写一次。太勤会让这段话变成「今天心情播报」。 */
const REFRESH_MS = 24 * 60 * 60 * 1000;
const MAX_BODY = 120;
const MAX_TAGS = 4;
const MEM_LIMIT = 30;
const JOURNAL_LIMIT = 10;

/** 最近一条「我眼里的你」。没有返回 null。 */
export async function readUnderstanding() {
  try {
    const rows = await listLatest(KIND, { limit: 1 });
    return rows.length ? rows[0] : null;
  } catch (err) {
    console.warn('[understanding] 读取失败', err);
    return null;
  }
}

function memLine(r) {
  const v = (r && r.value) || {};
  return [v.title, v.summary].filter(Boolean).join('：').slice(0, 80);
}

function journalLine(r) {
  const v = (r && r.value) || {};
  const day = v.day || '';
  const t = [v.title, v.diary || v.thoughts].filter(Boolean).join(' · ');
  return [day, t].filter(Boolean).join(' ').slice(0, 100);
}

const SYSTEM = [
  '你替「艾莲」写一段她眼里对「他」的印象，用第二人称「你」说给他听。',
  '只输出 JSON，不要解释：{"body":"一段不超过 120 字的描述","tags":["短词"]}',
  '写法：具体，落到记忆里真实出现过的事（名字、习惯、他怕的东西、一起做过的事），不要空泛夸人。',
  '不要写「你是一个善良的人」这种谁都能套的话；不许编造记忆里没有的事。',
  '称呼他时用「你」，不要出现「用户」「对方」。tags 给 2–4 个 2–4 字的短词。',
].join('\n');

/**
 * 生成一段描述（只调模型，不落库）。
 * @returns {Promise<{ok:boolean, value?:object, reason?:string, raw?:string}>}
 */
export async function compose({ config, memories = [], journals = [], at = Date.now() } = {}) {
  if (!config || !config.apiKey) return { ok: false, reason: 'noConfig' };
  const mems = memories.map(memLine).filter(Boolean).slice(0, MEM_LIMIT);
  const days = journals.map(journalLine).filter(Boolean).slice(0, JOURNAL_LIMIT);
  if (!mems.length && !days.length) return { ok: false, reason: 'empty' };

  const prompt = [
    mems.length ? `我记住的事：\n${mems.map((t) => `- ${t}`).join('\n')}` : '',
    days.length ? `我写过的手记：\n${days.map((t) => `- ${t}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  let raw = '';
  try {
    raw = await ask({
      config,
      maxTokens: 500,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: prompt },
      ],
    });
  } catch (err) {
    console.warn('[understanding] 模型调用失败', err);
    return { ok: false, reason: 'requestFailed', raw: String((err && err.message) || err) };
  }

  const json = looseJson(stripFence(raw)) || {};
  const body = String(json.body || json.text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_BODY);
  if (!body) return { ok: false, reason: 'emptyOutput', raw };

  const tags = Array.isArray(json.tags)
    ? json.tags.map((t) => String(t || '').trim().slice(0, 6)).filter(Boolean).slice(0, MAX_TAGS)
    : [];
  // sourceIds / sourceAt 记下「这段话是看了哪些东西写的」，下次判断有没有更新要用
  const sourceIds = [
    ...memories.slice(0, MEM_LIMIT).map((r) => r && r.headId).filter(Boolean),
    ...journals.slice(0, JOURNAL_LIMIT).map((r) => r && r.headId).filter(Boolean),
  ];
  const sourceAt = Math.max(
    0,
    ...memories.map((r) => Number((r && r.value && r.value.updatedAt) || (r && r.at)) || 0),
    ...journals.map((r) => Number((r && r.value && r.value.updatedAt) || (r && r.at)) || 0),
  );
  return { ok: true, raw, value: { body, tags, sourceIds, sourceAt, updatedAt: at, editedBy: 'ellen' } };
}

/** 落库：单独一步，失败只 warn。 */
export async function writeUnderstanding(value) {
  const v = { ...(value || {}) };
  const at = Number(v.updatedAt) || Date.now();
  v.updatedAt = at;
  try {
    const rec = await appendRecord({ kind: KIND, value: v, threadId: null, at });
    return { ok: true, headId: rec && rec.headId, value: v };
  } catch (err) {
    console.warn('[understanding] 写入失败', err);
    return { ok: false, reason: 'writeFailed', error: String((err && err.message) || err) };
  }
}

/** 记忆里最新一条的更新时间（用来判断「这段描述过不过期」）。 */
export function newestAt(rows) {
  let max = 0;
  for (const r of rows || []) {
    const t = Number((r && r.value && r.value.updatedAt) || (r && r.at)) || 0;
    if (t > max) max = t;
  }
  return max;
}

let running = false;

/**
 * 一次完整的「该写吗 → 写 → 落库」。
 * @returns {Promise<{status:'written'|'skipped'|'failed', reason?:string, value?:object}>}
 */
export async function maybeRefresh({ config, memories = [], journals = [], at = Date.now(), force = false } = {}) {
  if (running) return { status: 'skipped', reason: 'running' };
  if (!config || !config.apiKey) return { status: 'skipped', reason: 'noConfig' };
  if (!memories.length && !journals.length) return { status: 'skipped', reason: 'noData' };

  const last = await readUnderstanding();
  if (!force && last) {
    const lastAt = Number((last.value && last.value.updatedAt) || last.at) || 0;
    if (at - lastAt < REFRESH_MS) return { status: 'skipped', reason: 'fresh', lastAt };
    const lastSource = Number(last.value && last.value.sourceAt) || 0;
    const fresh = Math.max(newestAt(memories), newestAt(journals));
    if (fresh && fresh <= lastSource) return { status: 'skipped', reason: 'unchanged', lastAt };
  }

  running = true;
  try {
    const res = await compose({ config, memories, journals, at });
    if (!res.ok) return { status: 'failed', reason: res.reason };
    const w = await writeUnderstanding(res.value);
    if (!w.ok) return { status: 'failed', reason: w.reason };
    return { status: 'written', value: w.value, headId: w.headId };
  } finally {
    running = false;
  }
}

export function isRunning() {
  return running;
}
