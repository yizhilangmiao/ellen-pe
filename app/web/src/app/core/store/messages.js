// 消息存取：把聊天消息映射到事件溯源记录。
//
// value 字段照旧包 message 的子集（contract/M4-数据模型-真机实测.md），
// 保留 role / text / status / createdAt / threadId / messageOrder / replyToUserIds，
// 新壳额外带 failed / detail（旧包没有，多余字段旧包读时会被忽略）。
import { appendRecord, currentThreadId, deviceId, recentRecords, reviseRecord } from './records.js';
import { getMeta, putMeta } from './records.js';

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
  };
}

/** 追加一条消息并落库。返回可直接给视图用的对象。 */
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
  };
  if (msg.failed) value.failed = true;
  if (msg.detail) value.detail = msg.detail;
  const { headId } = await appendRecord({ kind: 'message', value, threadId, at: createdAt });
  await markFirstMessage(createdAt);
  // headId / value / threadId 交给上层保管，后续改这条消息要用
  return { ...toView({ id: headId, revisionId: null, value, at: createdAt }), headId, value, threadId };
}

/** 改一条消息（流式收尾、失败标记都走这里）。调用方给完整 value。 */
export async function replaceMessage(headId, value) {
  await reviseRecord(headId, value);
}

/** 读某线程最近 limit 条（升序）。 */
export async function loadMessages(threadId = null, limit = 200) {
  const tid = threadId || (await currentThreadId());
  const revs = await recentRecords('message', tid, limit);
  // headId / value 一起带出去：从历史加载的消息后续也可能被改（继续生成、补标记）
  return revs.map((r) => ({ ...toView(r), headId: r.id, value: r.value, threadId: tid }));
}

export { currentThreadId };
