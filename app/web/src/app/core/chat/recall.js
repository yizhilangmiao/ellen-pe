// 记忆召回：把「你这句话」和「她记得的事」对上号。
//
// 打分是三层的，从便宜到贵：
//   ① 字面（BM25/IDF 加权的二元组重叠）：毫秒级，永远在跑，任何情况都不空转；
//   ② 概念（同义词/上位词归并）+ 标签（记忆自己带的 tags）：补字面接不住的换词；
//   ③ 向量（bge-small-zh-v1.5，本地 WASM）：补前两层都接不住的「换个说法」。
//
// 为什么要三层而不是只上向量：向量模型加载要几秒、首次建库要几十秒，
// 这段时间里她不能失忆 —— ①② 顶着；模型没好、被系统杀掉、内存不足，也是 ①② 顶着。
// 向量是增强，不是前提。
//
// 旧注释里那句「不上向量库」的结论没删错，是前提变了：
//   当时怕的是「每句一次 embedding 请求」和「WebView 背模型」。现在模型在本机跑
//   （一次 30~80 ms）、向量持久缓存在 IndexedDB，两个前提都不成立了。详见 chat/embed.js 头注释。
//
// 召回到的记忆由 chat/session.js 拼进 system 段，不进聊天记录。
import { listLatest } from '../store/library.js';
import { openDb, STORE_HEADS, STORE_REVISIONS } from '../store/db.js';
import {
  cosine,
  embedOne,
  embedStatus,
  embedMany,
  loadVectors,
  saveVectors,
  vectorKey,
} from './embed.js';

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

/**
 * 分数上限：BM25 的原始分没有上界，召回要的是 0..1 之间的可比较分。
 * 除以 sqrt(len) 之后单条记录最多约 len/1.2 分（一条全中的短句），所以用这个归一。
 * 实测（_临时/recall-bench）：直接截断会让长记忆吃亏，这个归一在 200 条样本上没有偏。
 */
function bm25Term(idf, tf, len, avgLen, k1 = 1.2, b = 0.75) {
  if (!tf) return 0;
  const norm = 1 - b + b * (len / (avgLen || 1));
  return idf * ((tf * (k1 + 1)) / (tf + k1 * norm));
}

// —— 概念表：在聊什么 ——
//
// 为什么要有它：字面二元组接不住换词（「那部电影没看完」/「片子看到一半」共享 0 个 bigram），
// 向量接不住专名（「豆豆」和「橘猫」在她的记忆里是同一条，但通用模型不知道）。
// 两张表各补一块，缺一不可。
//
// 表的维护原则：**只收「日常真会发生」的组**，宁可漏不要滥 ——
// 多一个概念，所有记忆的 concept 分母都变，误召回是全局性的，不是局部的。
export const CONCEPTS = [
  // 影视音
  ['movie', ['电影', '片子', '影片', '看片', '院线', '上映', '影院', '剧情', '首映', '排片']],
  ['tv', ['电视剧', '剧集', '追剧', '追番', '番剧', '综艺', '剧']],
  ['music', ['歌', '听歌', '音乐', '耳机', '专辑', '演唱会', '单曲', '循环', '歌单']],
  ['game', ['游戏', '打游戏', '抽卡', '上分', '开黑', 'steam', '手游', '排位', '副本']],
  // 状态
  ['unfinished', ['没看完', '看到一半', '没接着看', '半途', '断在', '没听完', '没读完', '没做完']],
  ['sleep', ['睡', '睡着', '睡过去', '打盹', '眯', '困', '枕头', '被子', '失眠', '熬夜', '作息', '午觉', '午睡', '起床']],
  ['tired', ['累', '疲', '乏', '撑不住', '没力气', '上班', '加班', '忙', '扛不住']],
  ['mood', ['烦', '难过', '委屈', '生气', '焦虑', '压力', '哭', 'emo', '不爽', '低落', '崩']],
  ['happy', ['开心', '高兴', '笑', '爽', '舒服', '惊喜', '雀跃']],
  ['miss', ['想你', '想念', '好久不见', '好久没', '惦记', '在不在']],
  ['quarrel', ['吵架', '冷战', '不理我', '凶我', '闹别扭', '拌嘴', '道歉', '对不起', '原谅']],
  ['praise', ['厉害', '好棒', '好看', '可爱', '真行', '佩服', '羡慕']],
  ['askhelp', ['帮我', '怎么办', '教我', '能不能', '可不可以', '求助', '问你']],
  // 身体与吃
  ['food', ['吃', '饭', '菜', '外卖', '点菜', '下馆子', '奶茶', '咖啡', '辣', '甜', '口味', '忌口', '早餐', '午饭', '晚饭', '宵夜']],
  ['body', ['疼', '痛', '病', '药', '过敏', '发烧', '感冒', '体检', '牙', '胃', '头疼', '嗓子', '眼睛']],
  // 人与关系
  ['pet', ['猫', '狗', '宠物', '养', '豆豆', '铲屎', '遛狗', '喂猫']],
  ['people', ['妈', '爸', '父母', '哥', '姐', '弟', '妹', '朋友', '同事', '老板', '室友', '同学', '家里人']],
  ['rel', ['在一起', '告白', '称呼', '分手', '喜欢我', '爱我', '抱抱', '亲亲', '约会']],
  ['like', ['喜欢', '讨厌', '爱', '中意', '偏爱', '最想', '最爱', '不喜欢']],
  // 做事
  ['work', ['工作', '上班', '项目', '客户', '公司', '辞职', '面试', '出差', '开会', '汇报', '方案']],
  ['study', ['课', '考', '作业', '学校', '毕业', '论文', '老师', '背书', '复习', '考试']],
  ['plan', ['打算', '计划', '准备', '要买', '存钱', '报名', '约好', '下次', '以后', '明天', '周末']],
  ['commute', ['地铁', '公交', '打车', '开车', '堵车', '路上', '出门', '通勤', '赶车', '高铁', '飞机']],
  // 生活
  ['money', ['花钱', '好贵', '便宜', '存钱', '工资', '买单', '房租', '花了', '省点', '预算']],
  ['shop', ['买', '快递', '下单', '淘宝', '退货', '到了', '包裹', '购物车', '秒杀']],
  ['cloth', ['穿', '衣服', '鞋', '外套', '裙子', '裤子', '冷', '热', '换季']],
  ['home', ['回家', '房间', '床', '收拾', '搬家', '打扫', '厨房', '阳台', '客厅']],
  ['phone', ['手机', '充电', '没电', '屏幕', '壳', '卡顿', '内存', '流量']],
  ['travel', ['旅游', '出去玩', '订票', '酒店', '出发', '景区', '放假', '假期']],
  ['gift', ['礼物', '送你', '生日', '纪念日', '惊喜', '红包']],
  ['weather', ['下雨', '天气', '太阳', '晒', '风大', '下雪', '降温', '台风', '雾']],
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

/** 字面分（IDF 加权版；无索引统计时退化为旧的重叠分）。 */
export function literalScorer() {
  return (query, item) => {
    const bag = item && item.bag;
    if (!bag) return 0;
    if (!query.idf) return overlapScore(query.tokens, bag);
    return idfScore(query, bag, item);
  };
}

/** 概念重合分：命中几个概念，按「这条记录有几个概念」归一。 */
export function conceptScore(qConcepts, tConcepts) {
  if (!qConcepts || !qConcepts.size || !tConcepts || !tConcepts.size) return 0;
  let hit = 0;
  for (const c of tConcepts) if (qConcepts.has(c)) hit++;
  // 除以 sqrt 会让「概念组很少的那条」超过 1（3 组全中 = 3/1.73 = 1.73），
  // 混合分里它是加权项，超过 1 会把别的层压死，所以这里必须封顶。
  return Math.min(1, hit / Math.sqrt(tConcepts.size));
}

/**
 * 语义 scorer（无向量版）：max(字面, 0.85 × 概念分)。
 * 为什么乘 0.85：单靠一个概念（比如都提到「电影」）就满分的话，凡是聊过的电影都会挤进来；
 * 压到 0.85 之后它仍明显高于字面分，但压不过「概念 + 字面都中」的那一条。
 * 为什么用 max 而不是加权求和：字面中得很好的那条不该被概念分稀释（文档：合分用 max）。
 */
export function semanticScorer({ weight = 0.85 } = {}) {
  return (query, item) => {
    const literal = literalScorer()(query, item);
    const sem = weight * conceptScore(query.concepts, item && item.concepts);
    return Math.max(literal, sem);
  };
}

/** 标签分：记忆自带 tags，命中就是强信号（比正文撞词可靠）。 */
export function tagScore(qTokens, qConcepts, tags) {
  if (!tags || !tags.length) return 0;
  let hit = 0;
  for (const tag of tags) {
    const t = String(tag || '').toLowerCase().trim();
    if (!t) continue;
    if (qTokens.has(t) || [...qTokens].some((q) => q.length >= 2 && t.includes(q))) hit += 1;
    else {
      const tc = conceptsOf(t);
      for (const c of tc) if (qConcepts.has(c)) { hit += 0.6; break; }
    }
  }
  return Math.min(1, hit / Math.sqrt(tags.length));
}

/** 默认 scorer 的名字：调用方写 `scorer: 'semantic'` 也行，省得自己拼。 */
export const SCORERS = { literal: literalScorer, semantic: semanticScorer };

function textOfEntry(entry) {
  const v = entry.value || {};
  const tags = Array.isArray(v.tags) ? v.tags.join(' ') : '';
  if (entry.kind === 'memory') {
    return [v.title, v.subject, tags, v.summary, v.body, v.reason].filter(Boolean).join(' ');
  }
  if (entry.kind === 'journal') {
    return [v.title, tags, v.diary, v.thoughts, v.understanding && v.understanding.body].filter(Boolean).join(' ');
  }
  return [v.title, tags, v.summary, v.text].filter(Boolean).join(' ');
}

function tagsOfEntry(entry) {
  const tags = (entry.value || {}).tags;
  return Array.isArray(tags) ? tags : [];
}

function summarize(entry) {
  const v = entry.value || {};
  const title = v.title || v.subject || (entry.kind === 'journal' ? v.day : '') || '一件事';
  const body = v.summary || v.diary || v.thoughts || v.body || '';
  return { title: String(title), body: String(body).replace(/\s+/g, ' ').slice(0, 160) };
}

// ── 记忆索引缓存 ────────────────────────────────────────────────
// 为什么要有这一层：原来每条消息都调 listLatest(kind, {limit:300})，只看得见
// 「最近 300 条」。压测 5,000 条记忆时复现了老 bug ③ 的升级版：**最老那条永远
// 召回不到**（问「你还记得我那枚吊坠吗」她答「我不太清楚吊坠的事」）。
// 全量扫一遍 5,000 条实测 544 ms（读 heads 212 + 读 revisions 287 + 打分 44），
// 摊在每条消息上不可接受，所以：索引建一次缓存住，之后每次查询只打分（44 ms）。
// 写入（新记忆/新修改/新日记）会调 invalidateRecall() 让它重建，另外 5 分钟兜底过期。
const INDEX_TTL_MS = 5 * 60 * 1000;
const INDEX_MAX_ENTRIES = 20000; // 超过这个量级再谈分库，别偷偷截断而不报
let indexCache = null; // { at, entries: [...], idf: Map, avgLen: number }

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
 *   老数据没有 state 字段（undefined）一律当 active，不能因为升级就把以前的记忆静音。
 *   这里也在索引层过滤：兜底分支（一句没对上时退回最近几条）同样走这个索引，
 *   放行到打分之后再筛会漏掉它。
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
 * `view` 是给 scorer 的唯一入口：只有 kind / at / evidenceAt / text / bag / concepts / tags，
 * **没有 entry.value.state**。状态闸（recallable）在索引层就筛完了，scorer 想绕过也没有把手。
 * 这不是洁癖：以后谁接一个第三方 scorer，都不该有机会把「已翻篇」「别再提」的记忆塞回来。
 */
function makeItem(kind, entry) {
  const text = textOfEntry(entry).slice(0, 240);
  const value = entry.value || {};
  const tags = tagsOfEntry(entry);
  const item = {
    kind,
    entry,
    at: entry.at || 0,
    // evidenceAt：这条事实「发生」的时间（记忆里会带），比写入时间更贴近「多久以前的事」
    evidenceAt: Number(value.evidenceAt) || Number(entry.at) || 0,
    bag: tokens(text),
    concepts: conceptsOf(text),
    tags,
    key: entry.revisionId ? vectorKey(kind, entry.revisionId) : '',
    vec: null,
  };
  item.view = {
    kind: item.kind,
    at: item.at,
    evidenceAt: item.evidenceAt,
    text,
    bag: item.bag,
    concepts: item.concepts,
    tags,
  };
  return item;
}

/**
 * 建 IDF 表。用途：让「这个/今天/还是」这种高频 bigram 自动失权，
 * 「吊坠/豆豆/CT」这种只在那一条里出现过的词自动加权 —— 不用维护停用词表。
 */
function buildIdf(entries) {
  const df = new Map();
  let totalLen = 0;
  for (const e of entries) {
    totalLen += e.bag.size;
    for (const t of e.bag) df.set(t, (df.get(t) || 0) + 1);
  }
  const n = entries.length || 1;
  const idf = new Map();
  for (const [t, c] of df) idf.set(t, Math.log(1 + (n - c + 0.5) / (c + 0.5)));
  return { idf, avgLen: entries.length ? totalLen / entries.length : 1 };
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
        entries.push(makeItem(entry.kind, entry));
      }
    }
  }

  if (entries.length > INDEX_MAX_ENTRIES) {
    console.warn('[recall] 索引条目过多，按时间保留最近的', INDEX_MAX_ENTRIES, '条，共', entries.length);
    entries.sort((a, b) => b.at - a.at);
    entries.length = INDEX_MAX_ENTRIES;
  }
  const { idf, avgLen } = buildIdf(entries);
  indexCache = { at: Date.now(), entries, idf, avgLen };
  // 索引一建好就在后台啃向量，别等用户说完话才想起来
  warmVectors(indexCache);
  return entries;
}

// ── 向量预热 ────────────────────────────────────────────────────
//
// 首次装完 / 换模型后，全库向量是空的。这里分批编码并写回 IndexedDB：
// 每批 8 条、批间让出主线程，5000 条大约 3~5 分钟（后台跑，不挡聊天）。
// 编码完的条目当场挂到 item.vec 上，下一条消息立刻就能用向量分。
let warmState = { running: false, total: 0, done: 0, aborted: false };

/** 索引体检：条数、去重后的文本数、IDF 词表大小。重复条目会让同一条记忆挤满召回位。 */
export function indexStats() {
  const c = indexCache;
  if (!c) return null;
  const texts = new Set(c.entries.map((e) => e.view && e.view.text));
  return { entries: c.entries.length, uniqueText: texts.size, idf: c.idf ? c.idf.size : 0, avgLen: +(c.avgLen || 0).toFixed(1) };
}

export function warmStats() {
  return { ...warmState, status: embedStatus().status };
}

async function warmVectors(cache) {
  if (!cache || warmState.running) return;
  if (embedStatus().status === 'off') return;
  warmState = { running: true, total: cache.entries.length, done: 0, aborted: false };
  const my = warmState;
  try {
    const pending = cache.entries.filter((e) => e.key && !e.vec);
    if (!pending.length) return;

    // 先吃缓存：上次进程编过的不再算一遍
    const cached = await loadVectors(pending.map((e) => e.key));
    for (const e of pending) {
      const v = cached.get(e.key);
      if (v) {
        e.vec = v;
        my.done++;
      }
    }

    const todo = pending.filter((e) => !e.vec);
    for (let i = 0; i < todo.length; i += 8) {
      if (my.aborted || indexCache !== cache) return; // 期间索引被重建/写入打断，收手
      const chunk = todo.slice(i, i + 8);
      const vecs = await embedMany(chunk.map((e) => e.view.text));
      const save = [];
      for (let j = 0; j < chunk.length; j++) {
        const v = vecs[j];
        if (!v) continue;
        chunk[j].vec = v;
        save.push([chunk[j].key, v]);
      }
      if (save.length) await saveVectors(save);
      my.done += save.length;
      await new Promise((r) => setTimeout(r, 16)); // 让出主线程，别让界面卡
    }
  } catch (err) {
    console.warn('[recall] 向量预热中断：', err);
  } finally {
    my.running = false;
    if (my.done || my.total) {
      console.info(`[recall] 向量预热完成 ${my.done}/${my.total}`);
    }
  }
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

/** 查询侧：原文、二元组、概念。 */
export function queryOf(text) {
  const src = String(text || '');
  return { text: src, tokens: tokens(src), concepts: conceptsOf(src) };
}

/**
 * IDF 加权字面分（BM25 简化式）。
 *
 * 和旧的 overlapScore 的差别只有一个：每个命中的 bigram 按「有多罕见」加权。
 * 这样「今天」「这个」自动接近 0 分，而「吊坠」这种只出现在一条记忆里的词权重拉满 ——
 * 不需要维护停用词表，语料自己会说话。
 */
function idfScore(query, bag, item) {
  const idf = query.idf;
  if (!idf || !idf.size) return overlapScore(query.tokens, bag);
  let score = 0;
  let matched = 0;
  for (const t of bag) {
    if (!query.tokens.has(t)) continue;
    const w = idf.get(t) || 0;
    score += bm25Term(w, 1, bag.size, query.avgLen || bag.size);
    matched++;
  }
  if (!matched) return 0;
  // 归一化用 x/(x+cap) 而不是 x/cap 再 min(1,…)：后者只要命中一两个高频词就顶到 1.00，
  // 于是「沾了一个字」和「整句都在说这件事」拿到同一个分，混合分里这层就失去区分度。
  // 分母随长度走：查询越长，同样几个词命中的意义越小。
  const cap = Math.max(1.2, Math.sqrt(query.tokens.size || 1) * 1.6);
  return score / (score + cap);
}

/**
 * 一条记录的打分视角（见 makeItem 里 view 的说明）。给测试与外部 scorer 用。
 */
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
    tags: tagsOfEntry(e),
  };
}

/**
 * 也算一次分，但 scorer 抛错/返回垃圾时静默退回字面分。
 *
 * 为什么降级而不是抛上去：召回是每条消息都要走的路，一个第三方 scorer 的 bug
 * 不该让「她突然想不起任何事」。宁可这轮只是字面匹配，也不能整段召回消失。
 */
export function scoreEntry(query, view, scorer = null) {
  const literal = view && view.bag && query.idf
    ? idfScore(query, view.bag, view)
    : overlapScore(query.tokens, (view && view.bag) || new Set());
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
 * 混合分：向量 / 字面 / 概念+标签 三层按权重合。
 *
 * 权重的依据（_临时/recall-bench 用 240 条合成记忆 + 60 条查询跑出来的）：
 *   · 向量单用：同义句 hit@1 最好，但专名（豆豆/吊坠）会输给「看起来更像」的另一条；
 *   · 字面单用：专名最准，换词就归零；
 *   · 0.62/0.26/0.12 是两者都能拿高分、任一层塌掉另一层托住的点。
 * 没有向量的条目按 0 参与向量项（不按字面假装成向量），它们靠 0.26+0.12 争，
 * 预热完成后自然回到正常排名 —— 宁可短暂偏低，也不要给新记忆虚高的分。
 */
export const HYBRID_WEIGHTS = { vector: 0.62, literal: 0.26, concept: 0.12 };

/**
 * 向量底噪。
 *
 * bge 系列对「两句毫无关系的中文短句」也常给出 0.32~0.42 的余弦 —— 实测 6 条互不相关的
 * 生活记忆，最高一对 0.417，最低 0.322。这是模型的性质（各向异性），不是 bug。
 * 直接拿余弦进混合分，等于每条记忆白送 0.62*0.42≈0.26 分，minScore 形同虚设，
 * 一句话把整个记忆库都召回进 prompt —— 比不召回更糟，她会把不相干的事缝在一起说。
 *
 * 所以先把底噪减掉再拉伸到 0~1。
 *
 * 0.30 是实测挑的，不是拍的：40 条合成记忆 × 26 条查询（含 2 条纯噪声）跑出来的
 * 余弦分布是 均值 0.27~0.37、噪声 top 0.37~0.53、真命中 0.46~0.79。
 * 底噪和弱信号在 0.36~0.45 这一段是重叠的，用 0.36 当 floor 会把「换了说法但同一个意思」
 * 的球全踢掉（实测「脖子后面发紧」→「最近肩膀酸」cos 0.456，减 0.36 后只剩 0.15，
 * 卡在门槛下面）；降到 0.30 后同一对拿 0.22，过线，全库 hit@1 从 23/26 变 26/26，
 * 噪声查询的召回条数一条没涨（多余的量由 passesHybrid 的绝对分地板挡着）。
 */
export const VEC_FLOOR = 0.3;

export function vecTerm(cos) {
  if (!(cos > 0)) return 0;
  return Math.max(0, (cos - VEC_FLOOR) / (1 - VEC_FLOOR));
}

/**
 * 三层分项 + 加权总分。
 *
 * 分项单独返回，是因为「过线」不能只看总分：概念层一对就锁满 0.12，
 * 光这一项就能把阈值顶过去（实测「凌晨还睁着眼睛」会召回「最近肩膀酸」——
 * 两者同属 body 概念组，字面一个 bigram 都不重合，纯粹是概念表太粗）。
 */
function hybridParts(query, item, qVec) {
  const literal = item.view ? idfScore(query, item.view.bag, item.view) : 0;
  const concept = Math.max(
    conceptScore(query.concepts, item.view && item.view.concepts),
    tagScore(query.tokens, query.concepts, item.view && item.view.tags) * 0.9,
  );
  let vec = 0;
  if (qVec && item.vec) {
    vec = vecTerm(cosine(qVec, item.vec));
  }
  const score = HYBRID_WEIGHTS.vector * vec + HYBRID_WEIGHTS.literal * literal + HYBRID_WEIGHTS.concept * concept;
  return { vec, literal, concept, score };
}

/**
 * 该不该召回这条。
 *
 * 先看绝对分地板（score ≥ 0.12），再看证据类型，任一条成立即可：
 *   ① 向量说像（vec ≥ 0.12，即原始余弦 ≥ 0.38）：语义层最可信，给了分就算数；
 *   ② 字面重合（literal ≥ 0.18）：IDF 加权后的重合，够扎实；
 *   ③ 概念极强（concept ≥ 0.9 且总分 ≥ 0.2）：整条记忆只落在一个概念组里、正好对上，
 *      这种「窄而准」的情况才允许纯概念单独成立。
 *
 * 门槛为什么这么低：这是**记忆召回**不是搜索。漏召回 = 她忘了你说过什么，
 * 用户能立刻感觉到；多召回一条同主题的旧事，最坏只是多说一句话。
 * 两个方向的代价不对称，所以门槛往「宁多勿漏」压，靠下面弱信号闸和
 * minScore 兜住精度。实测放宽后 26/26 全中，噪声召回条数没变。
 */
function passesHybrid({ vec, literal, concept, score }) {
  if (score < 0.12) return false;
  if (vec >= 0.12) return true;
  if (literal >= 0.18) return true;
  return concept >= 0.9 && score >= 0.2;
}

/**
 * 召回与这句话相关的记忆。
 * @param {string} text 用户刚说的话
 * @param {{limit?: number, minScore?: number, sources?: string[],
 *          scorer?: Function|'literal'|'semantic', now?: number, useVector?: boolean}} [opts]
 *   scorer 传了就用它（覆盖混合分）；不传 = 混合分（向量就绪时含向量）。
 *   useVector=false 强制走纯字面+概念（体检页对比用）。
 * @returns {Promise<Array<{kind,title,body,score,at}>>}
 */
export async function recall(
  text,
  { limit = 6, minScore = null, sources = ['memory', 'journal'], scorer = null, now = Date.now(), useVector = true, debug = false } = {},
) {
  const q = queryOf(text);
  const rows = [];
  const cached = indexCache && Date.now() - indexCache.at < INDEX_TTL_MS ? indexCache : null;
  const cache = cached || null;
  const index = cache ? cache.entries : await buildIndex(sources);
  const idf = (cache && cache.idf) || (indexCache && indexCache.idf) || null;
  const avgLen = (cache && cache.avgLen) || (indexCache && indexCache.avgLen) || 1;
  const q2 = { ...q, idf, avgLen };

  // 查询向量：只在模型已经就绪时同步等（30~80 ms）；还在加载就这轮先不用向量。
  let qVec = null;
  if (useVector && !scorer && embedStatus().status === 'ready') {
    try {
      qVec = await embedOne(text, { query: true });
    } catch {
      qVec = null;
    }
  }

  const fn = scorer ? pickScorer(scorer) : null;
  // 过线值按打分方式分档：纯字面/概念的分数尺度小（0~1 的 overlap），混合分另走 passesHybrid。
  const floor = minScore == null ? 0.16 : minScore;
  for (const item of index) {
    let score;
    let ok;
    let extra = null;
    if (fn) {
      score = scoreEntry(q2, item.view || item, fn);
      ok = score >= floor;
    } else if (qVec) {
      const parts = hybridParts(q2, item, qVec);
      score = parts.score;
      ok = minScore != null ? score >= minScore : passesHybrid(parts);
      if (debug) extra = parts;
    } else {
      score = semanticScorer()(q2, item.view || item);
      ok = score >= floor;
    }
    rows.push({ kind: item.kind, entry: item.entry, score, ok, extra, at: item.at, evidenceAt: item.evidenceAt || item.at });
  }

  const scored = rows.map((r) => {
    // 时间只做轻微加权：三个月内线性，之后归零。
    // 用 evidenceAt（事情发生的时间）而不是入库时间 —— 补录的旧事不该因为「刚写进去」而排到前面。
    const age = Math.max(0, now - (r.evidenceAt || r.at || now));
    const recency = Math.max(0, 1 - age / RECENCY_SPAN_MS) * RECENCY_WEIGHT;
    return { ...r, total: r.score + recency };
  });

  const hits = scored.filter((r) => r.ok).sort((a, b) => b.total - a.total);
  let picked = hits.slice(0, limit);

  // 弱信号闸：向量这条线在「这句话跟谁都不搭」时仍会给出几条擦边分（拉不开差距）。
  // 与其把一堆不相干的旧账灌进 prompt 让她串戏，不如只留最像的 2 条 —— 少一条没关系，
  // 错一条是硬伤（她会在完全不相关的时候提起上周的火锅）。
  if (qVec && !fn && picked.length > 2) {
    const ref = picked[Math.min(picked.length - 1, 3)];
    if (picked[0].score - ref.score < 0.05) picked = picked.slice(0, 2);
  }

  if (!picked.length) {
    // 一句都没对上：退回最近的几条，别让她失忆
    picked = scored.sort((a, b) => (b.entry.at || 0) - (a.entry.at || 0)).slice(0, Math.min(3, limit));
  }

  return picked.map((r) => ({
    kind: r.kind,
    at: r.at,
    score: Number(r.total.toFixed(3)),
    hit: Number(r.score.toFixed(3)),
    ...(debug && r.extra ? { parts: { vec: +r.extra.vec.toFixed(3), literal: +r.extra.literal.toFixed(3), concept: +r.extra.concept.toFixed(3) } } : {}),
    ...summarize(r.entry),
  }));
}

/** 把召回结果拼成一段给模型看的文字。没有就返回空串。 */
export function renderRecall(items) {
  if (!items || !items.length) return '';
  const lines = items.map((it, i) => `${i + 1}. [${it.kind === 'journal' ? '手记' : '记忆'}] ${it.title}：${it.body}`);
  return `这些是你记得的事，和现在的话题有关就用得上，不相关就忽略：\n${lines.join('\n')}`;
}
