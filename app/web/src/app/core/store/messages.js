// 消息存取：把聊天消息映射到事件溯源记录。
//
// value 字段照旧包（contract/M4-数据模型-真机实测.md）：
//   role / text / status / createdAt / threadId / messageOrder / replyToUserIds，
//   新壳额外带 failed / detail / audio / speech / voice（旧包读时忽略未知字段）。
//
// 2026-11-12 补齐（接口契约 §1，`md笔记\手机版-补齐-接口契约-2026-11-12.md`）：
//   新增 type / recalled / recalledAt / quoteOf / segIndex / segCount / image / tone。
//   一律**只增不改**：老数据（没有这些字段）读出来走安全默认，不改 status 枚举。
//
// 撤回为什么不加 status='recalled'：老包读到未知的两天前写的枚举值会当成未知状态，
// 列表里可能整条不渲染 —— 所以撤回只加一个布尔标记，文本原样保留。
import { latestOf, appendRecord, currentThreadId, deviceId, recentRecords, reviseRecord } from './records.js';
import { getMeta, putMeta } from './records.js';
import { STORE_HEADS, openDb } from './db.js';

/** 引用原文截断长度：气泡上只显示一行，整段原文会撑爆布局。 */
const QUOTE_TEXT_MAX = 80;

/** 单调序号：旧包用 {deviceId, ordinal} 定位消息顺序，跨设备也不撞。 */
async function nextOrdinal() {
  const n = (await getMeta('message-ordinal', 0)) || 0;
  const next = n + 1;
  await putMeta('message-ordinal', next);
  return next;
}

// 相处天数要「最早一条消息」的时间。每次写消息都去查一次太亏，进程内记一次就够了：
// 一旦写过就是写过，除非导入清库（那时 record.js 会清 localStorage 的标记位）。
let firstMessageAt = 0;

async function markFirstMessage(at) {
  if (firstMessageAt) return;
  const known = await getMeta('first-message', null);
  if (known) {
    firstMessageAt = known;
    return;
  }
  firstMessageAt = at;
  await putMeta('first-message', at);
}

/** 按字符（不是码元）截断，避免把表情/生僻字劈成半个乱码。 */
function clip(text, max) {
  const s = String(text || '');
  if (s.length <= max) return s;
  return [...s].slice(0, max).join('');
}

/**
 * 引用块的归一化。调用方可能传半截对象（老数据、手工构造、导入来的包），
 * 这里统一成契约里的形状，免得渲染层到处判空。
 * @returns {null | {headId:string, role:'user'|'assistant', type:string, text:string, createdAt:number}}
 */
function normalizeQuote(quote) {
  if (!quote || typeof quote !== 'object') return null;
  const headId = typeof quote.headId === 'string' ? quote.headId : '';
  if (!headId) return null;
  return {
    headId,
    role: quote.role === 'user' ? 'user' : 'assistant',
    type: typeof quote.type === 'string' && quote.type ? quote.type : 'text',
    text: clip(quote.text, QUOTE_TEXT_MAX),
    createdAt: Number.isFinite(quote.createdAt) ? quote.createdAt : 0,
  };
}

/** 图片载荷归一化（字段名照契约，缺的给 0/空串，不塞 undefined）。 */
function normalizeImage(image) {
  if (!image || typeof image !== 'object') return null;
  const uri = typeof image.uri === 'string' ? image.uri : '';
  const name = typeof image.name === 'string' ? image.name : '';
  if (!uri && !name) return null;
  return {
    uri,
    name,
    mimeType: typeof image.mimeType === 'string' ? image.mimeType : '',
    bytes: Number.isFinite(image.bytes) ? image.bytes : 0,
    width: Number.isFinite(image.width) ? image.width : 0,
    height: Number.isFinite(image.height) ? image.height : 0,
  };
}

/**
 * 按 record value 里已有的痕迹推导消息类型（纯函数，无副作用）。
 *
 * 判定顺序有讲究：image 证据最强（真带了图就一定是图片消息），
 * 其次是显式写的 type（导入/迁移过的数据信它），再是表情包 id，最后才看语音。
 * 都没有就是文本 —— 老数据绝大多数是文本，这样迁移后的表现与迁移前一致。
 * @param {object} value 一条消息的 value（或任何同形状对象）
 * @returns {'text'|'voice'|'image'|'expression'|'system'|'letter'|string}
 */
export function typeOfValue(value) {
  const v = value && typeof value === 'object' ? value : {};
  if (v.image && typeof v.image === 'object' && (v.image.uri || v.image.name)) return 'image';
  if (typeof v.type === 'string' && v.type) return v.type;
  if (typeof v.stickerId === 'string' && v.stickerId) return 'expression';
  if (v.audio || v.voice) return 'voice';
  return 'text';
}

/**
 * 把一条 value 补齐到 v4 形状（幂等：补齐过的再跑一遍不会变）。
 * import.js 读老备份、migrateMessages 扫老库都走这里，保证「外面补的」和「库里补的」一致。
 */
export function upgradeMessageValue(value) {
  const v = value && typeof value === 'object' ? { ...value } : {};
  if (typeof v.type !== 'string' || !v.type) v.type = typeOfValue(v);
  // recalled 落成显式布尔：读的时候不用区分「没这个字段」和「false」，
  // 老包看到多出来的布尔字段会忽略，不产生未知枚举。
  if (typeof v.recalled !== 'boolean') v.recalled = v.recalled === true;
  if (v.quoteOf === undefined) v.quoteOf = null;
  return v;
}

/** 还差哪些字段（迁移用：只有真缺才写新 revision，别把整库无谓地写一遍）。 */
function needsUpgrade(value) {
  const v = value && typeof value === 'object' ? value : null;
  if (!v) return true;
  if (typeof v.type !== 'string' || !v.type) return true;
  if (typeof v.recalled !== 'boolean') return true;
  if (v.quoteOf === undefined) return true;
  return false;
}

/**
 * revision → 视图对象。老数据缺字段时给安全默认（type:'text'、recalled:false、其余 null），
 * 这样渲染层不用到处写 `?? null`。
 * quoteMissing 在这里只能是 false：要判断「被引用的那条还在不在」得查库，
 * 单条转换是同步的，批量判断在 loadMessages 里统一做。
 */
function toView(rev) {
  const v = rev.value || {};
  return {
    id: rev.id,
    revisionId: rev.revisionId,
    role: v.role === 'user' ? 'user' : 'assistant',
    text: v.text || '',
    status: v.status || 'done',
    failed: !!v.failed,
    detail: v.detail || '',
    createdAt: v.createdAt || rev.at,
    pending: false,
    // 语音消息：audio 带 uri/bytes/durationMs/peaks（气泡只画波形），speech 只给模型看
    audio: v.audio || null,
    speech: v.speech || null,
    voice: !!v.voice,
    // —— v4 新增 ——
    type: typeOfValue(v),
    recalled: v.recalled === true,
    recalledAt: Number.isFinite(v.recalledAt) ? v.recalledAt : null,
    quoteOf: normalizeQuote(v.quoteOf),
    quoteMissing: false,
    segIndex: Number.isInteger(v.segIndex) ? v.segIndex : null,
    segCount: Number.isInteger(v.segCount) ? v.segCount : null,
    image: normalizeImage(v.image),
    stickerId: typeof v.stickerId === 'string' ? v.stickerId : '',
    tone: typeof v.tone === 'string' ? v.tone : '',
  };
}

/** 取 head（判断存在/是否已删）。撤回与引用校验都要它。 */
async function getHead(headId) {
  if (!headId) return null;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE_HEADS, 'readonly');
    const r = t.objectStore(STORE_HEADS).get(headId);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  });
}

/**
 * 追加一条消息并落库。返回可直接给视图用的对象。
 *
 * 契约 §1 新增的字段（type/quoteOf/segIndex/segCount/image/tone）只要调用方给了就落盘，
 * 没给也写显式默认值（null / ''），这样读端的形状是稳定的，不用猜「这字段到底存不存在」。
 */
export async function appendMessage(msg, threadIdArg = null) {
  const threadId = threadIdArg || (await currentThreadId());
  const createdAt = msg.createdAt || Date.now();
  const ordinal = await nextOrdinal();
  const value = {
    role: msg.role === 'user' ? 'user' : 'assistant',
    text: msg.text || '',
    status: msg.status || (msg.pending ? 'pending' : 'done'),
    language: msg.language || 'zh',
    createdAt,
    threadId,
    replyToUserIds: msg.replyToUserIds || [],
    messageOrder: { deviceId: deviceId(), ordinal },
    // v4 字段：type 由内容推导（msg 里带 image/stickerId/audio/voice 就自动定），
    // 显式传了 type 时以 msg.type 为准（信件/系统消息这类没有内容痕迹的类型只能靠显式传）
    type: typeof msg.type === 'string' && msg.type ? msg.type : typeOfValue(msg),
    recalled: msg.recalled === true,
    quoteOf: normalizeQuote(msg.quoteOf),
    segIndex: Number.isInteger(msg.segIndex) ? msg.segIndex : null,
    segCount: Number.isInteger(msg.segCount) ? msg.segCount : null,
    image: normalizeImage(msg.image),
    stickerId: typeof msg.stickerId === 'string' ? msg.stickerId : '',
    tone: typeof msg.tone === 'string' ? msg.tone : '',
  };
  if (msg.failed) value.failed = true;
  if (msg.detail) value.detail = msg.detail;
  // 语音消息：这两个字段不写进去，「杀掉 App 重启语音条还在」就是假的
  if (msg.audio) value.audio = msg.audio;
  if (msg.speech) value.speech = msg.speech;
  const { headId } = await appendRecord({ kind: 'message', value, threadId, at: createdAt });
  await markFirstMessage(createdAt);
  // headId / value / threadId 交给上层保管，后续改这条消息要用
  return { ...toView({ id: headId, revisionId: null, value, at: createdAt }), headId, value, threadId };
}

/** 改一条消息（流式收尾、失败标记都走这里）。调用方给完整 value。 */
export async function replaceMessage(headId, value) {
  await reviseRecord(headId, value);
}

/**
 * 撤回一条消息：只加标记，**不动 text**（气泡要显示「你撤回了一条消息」，但原文留着，
 * 将来做「撤回后可恢复」或审计都还有据可查）。
 *
 * 2 分钟窗口不在这里判：写库层不该依赖「现在几点」，窗口由调用方（聊天页）判断，
 * 这里只管落库 —— 这样测试和导入迁移都能直接调。
 *
 * @param {string} headId
 * @returns {Promise<null|object>} 成功返回新的 value（含 recalled/recalledAt），
 *                                 找不到记录返回 null。注意它**不是**布尔：
 *                                 上层用 `if (await recallMessage(id))` 判断同样成立。
 */
export async function recallMessage(headId) {
  const head = await getHead(headId);
  if (!head || head.deleted) return null;
  const rev = await latestOf(head);
  const value = rev && rev.value && typeof rev.value === 'object' ? rev.value : {};
  if (value.recalled === true) return value; // 已经撤过：幂等，不重复写 revision
  const next = { ...value, recalled: true, recalledAt: Date.now() };
  // at 传原创建时间：reviseRecord 会用 at 覆盖 head.messageTime，
  // 传 Date.now() 会把这条老消息顶到列表最新（撤回一条三天前的消息，它会跳到末尾）。
  await reviseRecord(headId, next, { at: value.createdAt || head.messageTime || head.createdAt || Date.now() });
  return next;
}

/**
 * 批量标出「引用原文已经不在了」的条目。
 * 一次只读事务里把所有被引用的 head 取一遍：引用的原消息可能已被删（head.deleted），
 * 界面要据此显示 strings.zh 的 msg.quoteMissing，而不是点进去一片空白。
 */
async function markQuoteMissing(views) {
  const wanted = new Set();
  for (const m of views) {
    if (m.quoteOf && m.quoteOf.headId) wanted.add(m.quoteOf.headId);
  }
  if (!wanted.size) return;
  const db = await openDb();
  const missing = new Set();
  await new Promise((resolve) => {
    let t;
    try {
      t = db.transaction(STORE_HEADS, 'readonly');
    } catch {
      resolve();
      return;
    }
    const store = t.objectStore(STORE_HEADS);
    // 所有 get 必须同步发出，事务才不会在 await 之间失活
    for (const id of wanted) {
      const r = store.get(id);
      r.onsuccess = () => {
        const head = r.result;
        if (!head || head.deleted) missing.add(id);
      };
    }
    t.oncomplete = () => resolve();
    t.onerror = () => resolve();
    t.onabort = () => resolve();
  });
  for (const m of views) {
    if (m.quoteOf) m.quoteMissing = missing.has(m.quoteOf.headId);
  }
}

/** 读某线程最近 limit 条（升序）。 */
export async function loadMessages(threadId = null, limit = 200) {
  const tid = threadId || (await currentThreadId());
  const revs = await recentRecords('message', tid, limit);
  // headId / value 一起带出去：从历史加载的消息后续也可能被改（继续生成、补标记）
  const views = revs.map((r) => ({ ...toView(r), headId: r.id, value: r.value, threadId: tid }));
  await markQuoteMissing(views);
  return views;
}

/** 库里所有 message 类 head（不过滤 profile：迁移要覆盖全部历史）。 */
async function allMessageHeads() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const out = [];
    const t = db.transaction(STORE_HEADS, 'readonly');
    const idx = t.objectStore(STORE_HEADS).index('kind');
    const cur = idx.openCursor(IDBKeyRange.only('message'));
    cur.onerror = () => reject(cur.error);
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) {
        resolve(out);
        return;
      }
      out.push(c.value);
      c.continue();
    };
  });
}

/**
 * 把老消息补到 v4 形状：扫全部 kind='message' 的 head，缺 type/recalled/quoteOf 的
 * 追加一条 revision（不改老 revision，事件溯源的老规矩）。
 *
 * 幂等：补齐过的 value 已经有这三个字段，第二次跑 needsUpgrade 全 false，
 * 一条也不写。所以启动时无脑调它就够，不用记「迁移跑过没有」的标记位。
 *
 * @returns {Promise<{scanned:number, changed:number}>} 扫了多少条 / 补了多少条
 */
export async function migrateMessages() {
  const heads = await allMessageHeads();
  let changed = 0;
  for (const head of heads) {
    const rev = await latestOf(head);
    if (!rev) continue;
    if (!needsUpgrade(rev.value)) continue;
    const value = upgradeMessageValue(rev.value);
    // at 用原创建时间：迁移不是「消息更新了」，不该打乱列表顺序与相处天数
    const at = value.createdAt || head.messageTime || head.createdAt || Date.now();
    await reviseRecord(head.id, value, { at });
    changed += 1;
  }
  return { scanned: heads.length, changed };
}

export { currentThreadId };
