// 记忆召回：把「你这句话」和「她记得的事」对上号。
//
// 旧版的病（老 bug ③）：召回永远是同样 7 条 —— 打分只看时间窗不看内容，
// 于是聊天再久，她回忆的还是那几句。这里改成：
//   1) 按当前这句话做中文二元组（bigram）重叠打分，落点越密分越高
//   2) 记忆标题/正文整段命中再加一档
//   3) 时间只做轻微加权（0.15），不让「新的」压掉「对的」
//   4) 一条都没命中时才退回最近的几条，避免聊天空转
//
// 召回到的记忆由 chat/session.js 拼进 system 段，不进聊天记录。
import { listLatest } from '../store/library.js';
import { openDb, STORE_HEADS, STORE_REVISIONS } from '../store/db.js';

/** 中文按二元组切，英文/数字按整词。返回 Set。 */
export function tokens(text) {
  const out = new Set();
  const src = String(text || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/[，。！？、；：""''（）《》…—·~,.!?;:"'()<>[\]{}/\\|@#$%^&*+=_`]/g, ' ');
  for (const part of src.split(' ')) {
    if (!part) continue;
    if (/^[a-z0-9]+$/.test(part)) {
      if (part.length >= 2) out.add(part);
      continue;
    }
    const chars = [...part];
    if (chars.length === 1) {
      out.add(part);
      continue;
    }
    for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i] + chars[i + 1]);
  }
  return out;
}

function overlapScore(query, target) {
  if (!query.size || !target.size) return 0;
  let hit = 0;
  for (const t of target) if (query.has(t)) hit++;
  return hit / Math.sqrt(target.size || 1);
}

// —— R2：语义召回（可注入 scorer）——
//
// 为什么不上向量库：这条路的实测是 446 ms（见 readLatestOneTx 的注释），
// 向量化要么每句话多一次 embedding 请求、要么本地跑模型 —— 前者把召回从毫秒拖成秒级，
// 后者在安卓 WebView 里要背一份模型文件。用「同义词表 + 实体概念表」能拿到大部分收益：
// 「那部电影没看完」和「电影我睡着了」共享「电影」这个概念，字面分 0.45、概念分接近 1。
//
// 两张表的分工：
//   CONCEPTS 是「在聊什么」（电影 / 睡 / 吃 / 累 …），词与词之间算同一个概念；
//   tokens() 的二元组仍是「具体那件事」（豆豆 / 吊坠），概念只补它接不住的换词。
export const CONCEPTS = [
  ['movie', ['电影', '片子', '影片', '看片', '院线', '上映', '影院', '剧情', '电视剧', '剧']],
  ['unfinished', ['没看完', '看到一半', '没接着看', '半途', '断在', '没看完', '没听完', '没读完']],
  ['sleep', ['睡', '睡着', '睡过去', '打盹', '眯', '困', '枕头', '被子', '失眠', '熬夜', '作息']],
  ['food', ['吃', '饭', '菜', '外卖', '点菜', '下馆子', '奶茶', '咖啡', '辣', '甜', '口味', '忌口']],
  ['tired', ['累', '疲', '乏', '撑不住', '没力气', '上班', '加班', '忙']],
  ['mood', ['烦', '难过', '委屈', '生气', '焦虑', '压力', '哭', 'emo', '不爽']],
  ['happy', ['开心', '高兴', '笑', '爽', '舒服', '惊喜']],
  ['body', ['疼', '痛', '病', '药', '过敏', '发烧', '感冒', '体检', '牙', '胃']],
  ['pet', ['猫', '狗', '宠物', '养', '豆豆', '铲屎']],
  ['people', ['妈', '爸', '父母', '哥', '姐', '弟', '妹', '朋友', '同事', '老板', '室友', '同学']],
  ['work', ['工作', '上班', '项目', '客户', '公司', '辞职', '面试', '出差', '开会']],
  ['study', ['课', '考', '作业', '学校', '毕业', '论文', '老师', '背书']],
  ['like', ['喜欢', '讨厌', '爱', '中意', '偏爱', '最想']],
  ['plan', ['打算', '计划', '准备', '要买', '存钱', '报名', '约好', '下次']],
  ['rel', ['在一起', '告白', '称呼', '想你', '分手', '喜欢我', '爱我']],
];

/** 词 → 概念 id。同一张表两边共用，所以「同义」就是「同一个概念」。 */
const CONCEPT_WORDS = (() => {
  const out = [];
  for (const [id, words] of CONCEPTS) for (const w of words) out.push([id, w]);
  // 长词先判：「电视剧」不能只算成「剧」，「没看完」不该被「看」吃掉
  out.sort((a, b) => b[1].length - a[1].length);
  return out;
})();

/** 一段文字里出现了哪些概念（索引期算一次，查询期算一次）。 */
export function conceptsOf(text) {
  const src = String(text || '');
  const out = new Set();
  if (!src) return out;
  for (const [id, w] of CONCEPT_WORDS) if (src.includes(w)) out.add(id);
  return out;
}

/** 字面分（旧的 overlapScore，抽成可注入的 scorer）。 */
export function literalScorer() {
  return (query, item) => overlapScore(query.tokens, item && item.bag);
}

/** 概念重合分：命中几个概念，按「这条记录有几个概念」归一。 */
export function conceptScore(qConcepts, tConcepts) {
  if (!qConcepts || !qConcepts.size || !tConcepts || !tConcepts.size) return 0;
  let hit = 0;
  for (const c of tConcepts) if (qConcepts.has(c)) hit++;
  return hit / Math.sqrt(tConcepts.size);
}

/**
 * 语义 scorer：max(字面, 0.85 × 概念分)。
 * 为什么乘 0.85：单靠一个概念（比如都提到「电影」）就满分的话，凡是聊过的电影都会挤进来；
 * 压到 0.85 之后它仍明显高于字面分，但压不过「概念 + 字面都中」的那一条。
 * 为什么用 max 而不是加权求和：字面中得很好的那条不该被概念分稀释（文档：合分用 max）。
 */
export function semanticScorer({ weight = 0.85 } = {}) {
  return (query, item) => {
    const literal = overlapScore(query.tokens, item && item.bag);
    const sem = weight * conceptScore(query.concepts, item && item.concepts);
    return Math.max(literal, sem);
  };
}

/** 默认 scorer 的名字：调用方写 `scorer: 'semantic'` 也行，省得自己拼。 */
export const SCORERS = { literal: literalScorer, semantic: semanticScorer };

function textOfEntry(entry) {
  const v = entry.value || {};
  if (entry.kind === 'memory') {
    return [v.title, v.subject, v.summary, v.body, v.reason].filter(Boolean).join(' ');
  }
  if (entry.kind === 'journal') {
    return [v.title, v.diary, v.thoughts, v.understanding && v.understanding.body].filter(Boolean).join(' ');
  }
  return [v.title, v.summary, v.text].filter(Boolean).join(' ');
}

function summarize(entry) {
  const v = entry.value || {};
  const title = v.title || v.subject || (entry.kind === 'journal' ? v.day : '') || '一件事';
  const body = v.summary || v.diary || v.thoughts || v.body || '';
  return { title: String(title), body: String(body).replace(/\s+/g, ' ').slice(0, 160) };
}

/**
 * 召回与这句话相关的记忆。
 * @param {string} text 用户刚说的话
 * @param {{limit?: number, minScore?: number, sources?: string[]}} [opts]
 * @returns {Promise<Array<{kind,title,body,score,at}>>}
 */
// ── 记忆索引缓存 ────────────────────────────────────────────────
// 为什么要有这一层：原来每条消息都调 listLatest(kind, {limit:300})，只看得见
// 「最近 300 条」。压测 5,000 条记忆时复现了老 bug ③ 的升级版：**最老那条永远
// 召回不到**（问「你还记得我那枚吊坠吗」她答「我不太清楚吊坠的事」）。
// 全量扫一遍 5,000 条实测 544 ms（读 heads 212 + 读 revisions 287 + 打分 44），
// 摊在每条消息上不可接受，所以：索引建一次缓存住，之后每次查询只打分（44 ms）。
// 写入（新记忆/新修改/新日记）会调 invalidateRecall() 让它重建，另外 5 分钟兜底过期。
const INDEX_TTL_MS = 5 * 60 * 1000;
const INDEX_MAX_ENTRIES = 20000; // 超过这个量级再谈分库，别偷偷截断而不报
let indexCache = null; // { at, entries: [{kind, entry, at, bag}] }

/** 记忆/日记被写过后调用：下次 recall 重建索引。 */
export function invalidateRecall() {
  indexCache = null;
}

// 「一个事务读完一类记录」的旁路读法。
//
// 为什么不用 listLatest：它在 store/library.js:51 对**每条 head 各起一个事务**
// （`await getOne(STORE_REVISIONS, last)`）。压测 5,020 条记忆时实测：
// 逐条独立事务外推 2,333 ms，同样的读收进一个事务只要 446 ms —— 差 5 倍，
// 慢的原因就是事务个数，不是数据量。
//
// 为什么不直接改 library.js：它是公共读路径（记忆页、备份、聊天历史都走），
// 改它要连带动一大片回归。召回只需要「全量 + 末条 revision」，足够自己读，
// 所以在这里开个旁路，library.js 一个字不动。
//
// 顺带的好处：按 revisionId 精确取，不会扫到库里那些没有 head 的孤儿 revision。
//
// 返回结构和 listLatest 逐字段一致；失败时抛出去，由 buildIndex 回退老路。
function readLatestOneTx(kinds) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction([STORE_HEADS, STORE_REVISIONS], 'readonly');
    } catch (err) {
      reject(err);
      return;
    }
    const headStore = tx.objectStore(STORE_HEADS);
    const revStore = tx.objectStore(STORE_REVISIONS);
    const byKind = new Map();

    for (const kind of kinds) {
      byKind.set(kind, []);
      const req = headStore.index('kind').getAll(kind);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const heads = (req.result || []).filter(
          (h) => h && !h.deleted && Array.isArray(h.revisions) && h.revisions.length,
        );
        heads.sort((a, b) => {
          const ta = Number.isFinite(a.messageTime) ? a.messageTime : a.createdAt || 0;
          const tb = Number.isFinite(b.messageTime) ? b.messageTime : b.createdAt || 0;
          return tb - ta;
        });
        const bucket = byKind.get(kind);
        for (const h of heads) {
          const last = h.revisions[h.revisions.length - 1];
          const r = revStore.get(last);
          r.onsuccess = () => {
            const rev = r.result;
            if (!rev || rev.deleted) return;
            bucket.push({
              headId: h.id,
              kind: h.kind,
              threadId: h.threadId,
              revisionId: rev.revisionId,
              at: rev.at,
              value: rev.value,
              refs: rev.refs || [],
              createdAt: h.createdAt,
            });
          };
        }
      };
    }

    // 事务只在「没有挂起请求」时才提交，所以 heads 回调里追加的 get 都算数。
    tx.oncomplete = () => {
      const out = [];
      for (const kind of kinds) out.push(...(byKind.get(kind) || []));
      resolve(out);
    };
    tx.onerror = () => reject(tx.error || new Error('[recall] 批量读事务失败'));
    tx.onabort = () => reject(tx.error || new Error('[recall] 批量读事务被中止'));
  }));
}

/**
 * 这条记录能不能被召回。
 *
 * R1：记忆有状态了，只有 active 的算数 ——
 *   已翻篇（superseded）是「旧说法」，召回回来她会拿旧事实回答他；
 *   已退役（retired）是「别再提」，召回回来等于把他的话当耳旁风。
 * 老数据没有 state 字段（undefined）一律当 active，不能因为升级就把以前的记忆静音。
 * 这里也在索引层过滤：兜底分支（一句没对上时退回最近几条）同样走这个索引，
 * 放行到打分之后再筛会漏掉它。
 */
export function recallable(entry) {
  const v = entry && entry.value;
  if (!v) return true;
  if (v.state && v.state !== 'active') return false;
  if (v.muted) return false;
  return true;
}

/**
 * 建一条索引项。
 *
 * `view` 是给 scorer 的唯一入口：只有 kind / at / evidenceAt / text / bag / concepts，
 * **没有 entry.value.state**。状态闸（recallable）在索引层就筛完了，scorer 想绕过也没有把手。
 * 这不是洁癖：以后谁接一个第三方 scorer，都不该有机会把「已翻篇」「别再提」的记忆塞回来。
 */
function makeItem(kind, entry) {
  const text = textOfEntry(entry).slice(0, 240);
  const value = entry.value || {};
  const item = {
    kind,
    entry,
    at: entry.at || 0,
    // evidenceAt：这条事实「发生」的时间（记忆里会带），比写入时间更贴近「多久以前的事」
    evidenceAt: Number(value.evidenceAt) || Number(entry.at) || 0,
    bag: tokens(text),
    concepts: conceptsOf(text),
  };
  item.view = {
    kind: item.kind,
    at: item.at,
    evidenceAt: item.evidenceAt,
    text,
    bag: item.bag,
    concepts: item.concepts,
  };
  return item;
}

async function buildIndex(sources) {
  const entries = [];
  let all = null;
  try {
    all = await readLatestOneTx(sources);
  } catch (err) {
    console.warn('[recall] 单事务批量读失败，回退 listLatest：', err);
    all = null;
  }

  if (all) {
    for (const entry of all) {
      if (!recallable(entry)) continue;
      entries.push(makeItem(entry.kind, entry));
    }
  } else {
    for (const kind of sources) {
      let list = [];
      try {
        list = await listLatest(kind, { limit: 0 });
      } catch (err) {
        console.warn('[recall] 读不到', kind, err);
        continue;
      }
      for (const entry of list) {
        if (!recallable(entry)) continue;
        entries.push(makeItem(kind, entry));
      }
    }
  }

  if (entries.length > INDEX_MAX_ENTRIES) {
    console.warn('[recall] 索引条目过多，按时间保留最近的', INDEX_MAX_ENTRIES, '条，共', entries.length);
    entries.sort((a, b) => b.at - a.at);
    entries.length = INDEX_MAX_ENTRIES;
  }
  indexCache = { at: Date.now(), entries };
  return entries;
}

/** 时间加权系数。文档给的就是 0.15：只做轻微加权，不让「新的」压掉「对的」。 */
export const RECENCY_WEIGHT = 0.15;
const RECENCY_SPAN_MS = 90 * 24 * 3600 * 1000;

/** scorer 炸过一次就别每条消息都刷屏（一个进程只吵一次）。 */
let scorerWarned = false;

/** scorer 传字符串就查表，传函数就用它，不传（或写错名字）= 字面。 */
export function pickScorer(scorer) {
  if (typeof scorer === 'function') return scorer;
  if (typeof scorer === 'string') {
    const factory = SCORERS[scorer];
    if (typeof factory === 'function') return factory();
  }
  return literalScorer();
}

/** 查询侧的三样东西：原文、二元组、概念。 */
export function queryOf(text) {
  const src = String(text || '');
  return { text: src, tokens: tokens(src), concepts: conceptsOf(src) };
}

/** 一条记录的打分视角（见 makeItem 里 view 的说明）。给测试与外部 scorer 用。 */
export function entryView(entry) {
  const e = entry || {};
  const text = textOfEntry(e).slice(0, 240);
  return {
    kind: e.kind || '',
    at: e.at || 0,
    evidenceAt: Number((e.value || {}).evidenceAt) || Number(e.at) || 0,
    text,
    bag: tokens(text),
    concepts: conceptsOf(text),
  };
}

/**
 * 也算一次分，但 scorer 抛错/返回垃圾时静默退回字面分。
 *
 * 为什么降级而不是抛上去：召回是每条消息都要走的路，一个第三方 scorer 的 bug
 * 不该让「她突然想不起任何事」。宁可这轮只是字面匹配，也不能整段召回消失。
 */
export function scoreEntry(query, view, scorer = null) {
  const literal = overlapScore(query.tokens, view.bag);
  if (typeof scorer !== 'function') return literal;
  try {
    const v = Number(scorer(query, view));
    if (!Number.isFinite(v)) return literal;
    return Math.max(0, Math.min(1, v));
  } catch (err) {
    if (!scorerWarned) {
      scorerWarned = true; // 每进程只吵一次，别把控制台刷满
      console.warn('[recall] scorer 出错，退回字面分：', err);
    }
    return literal;
  }
}

/**
 * 召回与这句话相关的记忆。
 * @param {string} text 用户刚说的话
 * @param {{limit?: number, minScore?: number, sources?: string[],
 *          scorer?: Function|'literal'|'semantic', now?: number}} [opts]
 *   scorer(query, view) → 0..1；不传 = 字面分（与改造前完全一致）。
 *   想要语义召回传 semanticScorer() 或字符串 'semantic'。
 * @returns {Promise<Array<{kind,title,body,score,at}>>}
 */
export async function recall(
  text,
  { limit = 6, minScore = 0.16, sources = ['memory', 'journal'], scorer = null, now = Date.now() } = {},
) {
  const q = queryOf(text);
  const fn = scorer ? pickScorer(scorer) : null;
  const rows = [];
  const cached = indexCache && Date.now() - indexCache.at < INDEX_TTL_MS ? indexCache : null;
  const index = cached ? cached.entries : await buildIndex(sources);
  for (const item of index) {
    const score = scoreEntry(q, item.view || item, fn);
    rows.push({ kind: item.kind, entry: item.entry, score, at: item.at, evidenceAt: item.evidenceAt || item.at });
  }

  const scored = rows.map((r) => {
    // 时间只做轻微加权：三个月内线性，之后归零。
    // 用 evidenceAt（事情发生的时间）而不是入库时间 —— 补录的旧事不该因为「刚写进去」而排到前面。
    const age = Math.max(0, now - (r.evidenceAt || r.at || now));
    const recency = Math.max(0, 1 - age / RECENCY_SPAN_MS) * RECENCY_WEIGHT;
    return { ...r, total: r.score + recency };
  });

  const hits = scored.filter((r) => r.score >= minScore).sort((a, b) => b.total - a.total);
  let picked = hits.slice(0, limit);

  if (!picked.length) {
    // 一句都没对上：退回最近的几条，别让她失忆
    picked = scored.sort((a, b) => (b.entry.at || 0) - (a.entry.at || 0)).slice(0, Math.min(3, limit));
  }

  return picked.map((r) => ({
    kind: r.kind,
    at: r.at,
    score: Number(r.total.toFixed(3)),
    hit: Number(r.score.toFixed(3)),
    ...summarize(r.entry),
  }));
}

/** 把召回结果拼成一段给模型看的文字。没有就返回空串。 */
export function renderRecall(items) {
  if (!items || !items.length) return '';
  const lines = items.map((it, i) => `${i + 1}. [${it.kind === 'journal' ? '手记' : '记忆'}] ${it.title}：${it.body}`);
  return `这些是你记得的事，和现在的话题有关就用得上，不相关就忽略：\n${lines.join('\n')}`;
}
