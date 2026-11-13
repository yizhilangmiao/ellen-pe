// 旧包资料包（.ellenpack）解析 + 灌库。
//
// 格式依据（旧包 service chunk 逆向，见 contract/M4-数据模型-真机实测.md 与 M0 契约）：
//   容器 = "ELLENPK1\n"(9B) + int32 大端 manifest 字节长 + manifest(UTF-8) + 各文件字节
//   manifest v1 = { format:'ellen-companion-archive', version:1, package, files }            恰好 4 键
//   manifest v2 = { ...v1, version:2, selection, groupId, checksum }                        恰好 7 键
//   files[]     = { id, sha256, sizeBytes, mimeType } 或 { id, name, sha256, sizeBytes, mimeType }
//                 （后者带 name，语音附件用：name 就是 filesDir/attachments 里的文件名）
//   package     = { content, checksum }
//   content     = { format:'ellen-companion-transfer', formatVersion:1|2, packageId,
//                   origin:{deviceId,platform}, exportedAt, snapshot, media,
//                   lore?:{cardId} }         v1 恰好 7 键；v2 = 7 键 + 可选 lore
//                   lore 是手机版 2026-11-13 加的：记「用哪张角色卡」。老包没这个键，照常导入。
//   snapshot    = { schemaVersion, profiles:[], records:[] }                                恰好 3 键
//                  schemaVersion 1/2/3/4 都收；4 是当前（消息加了 type/recalled/quoteOf…）。
//                  读到老版本时按迁移规则把 message 的 value 就地补齐，老备份照样能导进来。
//   records[]   每项是**一次改动（revision）**，不是 head —— 旧包靠 id 分组重放
//
// 我们库里 heads 是独立表，所以导入时要按 id 分组把 head 重建出来。
import {
  STORE_HEADS,
  STORE_PROFILES,
  STORE_REVISIONS,
  openDb,
  reqDone,
  tx,
} from './db.js';
import { getMeta, invalidateProfile, putMeta } from './records.js';
import { upgradeMessageValue } from './messages.js';
import { applyLoreSelection, cardLabel, isKnownCard } from '../lore.js';

export const ARCHIVE_MAGIC = 'ELLENPK1\n';
export const ARCHIVE_FORMAT = 'ellen-companion-archive';
export const TRANSFER_FORMAT = 'ellen-companion-transfer';
/**
 * content 版本：1 = 老包（7 键，没有 lore）；2 = 带 lore（用哪张角色卡）。
 * 读的时候两个都认，写的时候写 2 —— 老包必须能导进来，这是兼容底线。
 */
export const CONTENT_FORMAT_VERSION = 2;
/** content 的基础键（v1 就有）；lore 是 v2 追加的可选键。 */
const CONTENT_BASE_KEYS = ['format', 'formatVersion', 'packageId', 'origin', 'exportedAt', 'snapshot', 'media'];
/** 包里带角色卡时给用户看的提示语；文案先落在这里，strings.zh.js 由 Lead 统一收。 */
export const LORE_PACK_HINT = '这份包含角色卡';

/**
 * 当前导出的快照版本。3 → 4 只加了消息字段，容器结构没变。
 * 定义在这里（而不是 export.js）是因为 export.js 已经 import 本文件，
 * 常量放同一处才不会绕出循环依赖。
 */
export const SNAPSHOT_SCHEMA_VERSION = 4;
/** 读得懂的旧版本：1/2/3 是历史包，4 是当前。 */
const READABLE_SCHEMA_VERSIONS = [1, 2, 3, 4];
const MANIFEST_MAX = 48 * 1024 * 1024;

/** 一批写多少条（避开手记保存 30 s 超时的老坑 ①）。 */
const BATCH = 1000;

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const HEX64 = /^[a-f0-9]{64}$/;
const MIME_RE = /^(image|video|audio)\/[a-zA-Z0-9.+-]{1,50}$/;
const GROUP_ID_RE = /^[a-zA-Z0-9:._-]{1,100}$/;

function keysAre(obj, expected) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const k = Object.keys(obj).sort().join('|');
  return k === [...expected].sort().join('|');
}

/** 只要求「这些键都在」，不要求恰好等于（给可选字段用）。 */
function hasKeys(obj, required) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  return required.every((k) => Object.prototype.hasOwnProperty.call(obj, k));
}

/**
 * 把整包字节切成 { manifest, blob }。
 * blob 是 manifest 之后剩余的字节（媒体文件区，本版只做元数据迁移，不解析）。
 */
export function splitArchive(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const magic = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 9));
  if (magic !== ARCHIVE_MAGIC) {
    throw fail('INVALID_ARCHIVE', '这不是艾莲资料包（文件头不对）。');
  }
  if (bytes.length < 13) throw fail('INVALID_ARCHIVE', '资料包被截断，读不到清单长度。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = view.getInt32(9, false);
  if (!Number.isFinite(len) || len <= 0 || len > MANIFEST_MAX) {
    throw fail('ARCHIVE_MANIFEST_TOO_LARGE', '资料文件清单超限或长度非法。');
  }
  if (13 + len > bytes.length) throw fail('INVALID_ARCHIVE', '资料包被截断，清单不完整。');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(13, 13 + len));
  return { manifestText: text, blob: bytes.subarray(13 + len) };
}

/** 校验 manifest 外形，返回 { version, manifest }。 */
export function parseManifest(raw) {
  const text = typeof raw === 'string' ? raw : String(raw || '');
  if (!text) throw fail('INVALID_ARCHIVE_MANIFEST', '资料文件清单是空的。');
  if (text.charCodeAt(0) === 0xfeff) throw fail('INVALID_ARCHIVE_MANIFEST', '资料文件清单带 BOM。');
  let m;
  try {
    m = JSON.parse(text);
  } catch {
    throw fail('INVALID_ARCHIVE_MANIFEST', '资料文件清单不是有效 JSON。');
  }
  if (!m || typeof m !== 'object' || m.format !== ARCHIVE_FORMAT) {
    throw fail('INVALID_ARCHIVE_MANIFEST', '不支持此资料文件格式。');
  }
  const v1 = keysAre(m, ['format', 'version', 'package', 'files']);
  const v2 = keysAre(m, ['format', 'version', 'package', 'files', 'selection', 'groupId', 'checksum']);
  if (!(m.version === 1 && v1) && !(m.version === 2 && v2)) {
    throw fail('INVALID_ARCHIVE_MANIFEST', '不支持此资料文件格式或字段。');
  }
  if (!Array.isArray(m.files) || m.files.length > 10000) {
    throw fail('INVALID_ARCHIVE_FILES', '文件清单无效或过多。');
  }
  const seen = new Set();
  for (const f of m.files) {
    // 两种形状都收：
    //   旧 {id,sha256,sizeBytes,mimeType}
    //   新 {id,name,sha256,sizeBytes,mimeType}（语音附件：name 就是附件文件名，id 与之一致）
    const legacyKeys = keysAre(f, ['id', 'sha256', 'sizeBytes', 'mimeType']);
    const namedKeys = keysAre(f, ['id', 'name', 'sha256', 'sizeBytes', 'mimeType']);
    if (!legacyKeys && !namedKeys) {
      throw fail('INVALID_ARCHIVE_FILES', '文件清单字段无效。');
    }
    if (namedKeys && (typeof f.name !== 'string' || !f.name)) {
      throw fail('INVALID_ARCHIVE_FILES', '文件名为空。');
    }
    if (typeof f.id !== 'string' || !f.id) throw fail('INVALID_ARCHIVE_FILES', '文件标识为空。');
    if (seen.has(f.id)) throw fail('INVALID_ARCHIVE_FILES', '文件标识重复。');
    seen.add(f.id);
    if (!HEX64.test(f.sha256)) throw fail('INVALID_ARCHIVE_FILES', '文件摘要无效。');
    if (!Number.isSafeInteger(f.sizeBytes) || f.sizeBytes <= 0) {
      throw fail('INVALID_ARCHIVE_FILES', '文件大小无效。');
    }
    const limit = (f.mimeType && f.mimeType.startsWith('image/') ? 32 : 128) * 1024 * 1024;
    if (f.sizeBytes > limit) throw fail('ARCHIVE_FILE_TOO_LARGE', '单个媒体超过资料文件容量限制。');
    if (typeof f.mimeType !== 'string' || !MIME_RE.test(f.mimeType)) {
      throw fail('INVALID_ARCHIVE_FILES', '文件媒体类型无效。');
    }
  }
  if (m.version === 2) {
    if (!(m.groupId === null || (typeof m.groupId === 'string' && GROUP_ID_RE.test(m.groupId)))) {
      throw fail('INVALID_BACKUP_GROUP', '备份组标识无效。');
    }
    if (typeof m.checksum !== 'string' || !HEX64.test(m.checksum)) {
      throw fail('CHECKSUM_MISMATCH', '分类备份摘要不一致。');
    }
  }
  return { version: m.version, manifest: m };
}

/** 取出 content（package 可能是内联对象，也可能是一段 JSON 字符串）。 */
export function parsePackage(pkg) {
  let decoded = pkg;
  if (typeof decoded === 'string') {
    if (decoded.length > MANIFEST_MAX) throw fail('PACKAGE_TOO_LARGE', '资料包超过上限。');
    try {
      decoded = JSON.parse(decoded);
    } catch {
      throw fail('INVALID_PACKAGE_JSON', '资料包不是有效 JSON。');
    }
  }
  if (!keysAre(decoded, ['content', 'checksum'])) {
    throw fail('INVALID_PACKAGE', '资料包封装字段无效。');
  }
  const content = decoded.content;
  if (!hasKeys(content, CONTENT_BASE_KEYS)) {
    throw fail('INVALID_PACKAGE', '资料包内容字段无效。');
  }
  // 严格键集校验换成「基础键都在 + 多出来的键必须是认识的」：
  // 这样 lore（v2）能过，拼错的字段名或被人塞进来的野字段还是会被拦。
  const extra = Object.keys(content).filter((k) => !CONTENT_BASE_KEYS.includes(k));
  if (extra.some((k) => k !== 'lore')) {
    throw fail('INVALID_PACKAGE', '资料包内容字段无效。');
  }
  if (content.format !== TRANSFER_FORMAT
    || (content.formatVersion !== 1 && content.formatVersion !== CONTENT_FORMAT_VERSION)) {
    throw fail('UNSUPPORTED_VERSION', '不支持此资料包格式或版本。');
  }
  if (typeof content.packageId !== 'string' || !content.packageId) {
    throw fail('INVALID_PACKAGE', '资料包标识为空。');
  }
  if (!keysAre(content.origin, ['deviceId', 'platform'])) {
    throw fail('INVALID_ORIGIN', '资料包来源无效。');
  }
  // media.mode 有两种：metadata-only（只带清单）/ include（附件字节也打进包里）。
  // 这里以前只认 metadata-only，结果「导出带语音的包 → 导入」直接报「媒体清单无效」——
  // 导出侧加了 include 却没同步改校验，是个真实的数据迁移死锁。
  if (!keysAre(content.media, ['mode', 'requiredIds'])
    || (content.media.mode !== 'metadata-only' && content.media.mode !== 'include')
    || !Array.isArray(content.media.requiredIds)) {
    throw fail('INVALID_MEDIA_MANIFEST', '媒体清单无效。');
  }
  return { content, checksum: decoded.checksum };
}

/**
 * 老备份里的一条 revision 补到当前形状。
 * 只动 message：memory/journal 那些带的字段集是另一套，别拿消息规则瞎补。
 */
function upgradeRecord(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  if (raw.kind !== 'message') return raw;
  if (!raw.value || typeof raw.value !== 'object') return raw;
  return { ...raw, value: upgradeMessageValue(raw.value) };
}

/** 校验 snapshot 外形，并把老版本的 message 记录补到当前形状后返回。 */
export function parseSnapshot(snapshot) {
  if (!keysAre(snapshot, ['schemaVersion', 'profiles', 'records'])) {
    throw fail('INVALID_SCHEMA', '资料快照字段无效（应为 schemaVersion/profiles/records）。');
  }
  if (!READABLE_SCHEMA_VERSIONS.includes(snapshot.schemaVersion)) {
    throw fail('UNSUPPORTED_VERSION', '不支持此数据版本。');
  }
  if (!Array.isArray(snapshot.profiles) || !Array.isArray(snapshot.records)) {
    throw fail('INVALID_SCHEMA', '资料列表无效。');
  }
  // 1/2/3 的老包：message 的 value 里没有 type/recalled/quoteOf，
  // 这里按迁移规则补齐再往下走，导入完的东西与本地新数据同形状（视图层不用分版本渲染）。
  // 幂等：补齐过的再跑一遍值不变，所以 v4 的包重复进入这条分支也没副作用。
  if (snapshot.schemaVersion < SNAPSHOT_SCHEMA_VERSION) {
    snapshot.records = snapshot.records.map((r) => upgradeRecord(r));
    // 补齐后这份快照已经是当前形状了，版本号跟着抬上去：
    // 后面再拿它做判断（或再走一次 parseSnapshot）就不会重复补一遍。
    snapshot.schemaVersion = SNAPSHOT_SCHEMA_VERSION;
  }
  return snapshot;
}

/**
 * 把 records（改动脉冲）按 head id 分组，重建成 heads + revisions。
 * 旧包没有独立的 head 表，head 是历史推出来的。
 *
 * @returns {{ heads: object[], revisions: object[], stats: object }}
 */
export function rebuildHeads(records) {
  const byHead = new Map();
  const revisions = [];
  let dropped = 0;

  for (const raw of records) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      dropped++;
      continue;
    }
    const headId = typeof raw.id === 'string' ? raw.id : '';
    const revisionId = typeof raw.revisionId === 'string' ? raw.revisionId : '';
    if (!headId || !revisionId) {
      dropped++;
      continue;
    }
    const rev = {
      id: headId,
      kind: typeof raw.kind === 'string' ? raw.kind : 'unknown',
      profileId: typeof raw.profileId === 'string' ? raw.profileId : '',
      revisionId,
      parents: Array.isArray(raw.parents) ? raw.parents.filter((x) => typeof x === 'string') : [],
      origin: raw.origin && typeof raw.origin === 'object'
        ? { deviceId: String(raw.origin.deviceId || ''), platform: String(raw.origin.platform || '') }
        : { deviceId: '', platform: '' },
      at: Number.isFinite(raw.at) ? raw.at : 0,
      deleted: raw.deleted === true,
      value: raw.value === undefined ? null : raw.value,
      refs: Array.isArray(raw.refs) ? raw.refs : [],
    };
    revisions.push(rev);
    if (!byHead.has(headId)) byHead.set(headId, []);
    byHead.get(headId).push(rev);
  }

  const heads = [];
  for (const [id, list] of byHead) {
    list.sort((a, b) => (a.at - b.at) || 0);
    const last = list[list.length - 1];
    const first = list[0];
    // threadId 在 revision 上没有单独字段，message 类从 value 里取（旧包同款）。
    const valueThread = last.value && typeof last.value === 'object' && typeof last.value.threadId === 'string'
      ? last.value.threadId
      : null;
    const threadId = valueThread;
    heads.push({
      id,
      kind: last.kind,
      profileId: last.profileId,
      threadId,
      createdAt: first.at,
      messageTime: last.kind === 'message' ? last.at : first.at,
      revisions: list.map((r) => r.revisionId),
      conflict: false,
      deleted: last.deleted === true,
      threadKeys: threadId ? [threadId] : [],
    });
  }

  return { heads, revisions, stats: { heads: heads.length, revisions: revisions.length, dropped } };
}

/**
 * 包里的 lore 只装一个 cardId。
 * 校验失败**不阻断导入**：角色卡选择丢了不影响聊天数据，为一颗字段把整包判死是本末倒置。
 */
function parseLore(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const cardId = raw.cardId;
  if (typeof cardId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(cardId)) return null;
  return { cardId };
}

/**
 * 这份包带不带角色卡——导入前提示用。
 * 为什么单独一个函数：提示要出现在 page-backup 的确认框里，那里只拿得到 content。
 */
export function describeLorePack(content) {
  const lore = content && typeof content === 'object' ? parseLore(content.lore) : null;
  if (!lore) return null;
  const known = isKnownCard(lore.cardId);
  return {
    cardId: known ? lore.cardId : null,
    label: known ? cardLabel(lore.cardId) : '',
    hint: known
      ? `${LORE_PACK_HINT}：${cardLabel(lore.cardId)}`
      : `${LORE_PACK_HINT}（这张卡本机没有，导入后仍用当前的）`,
  };
}

/** 导入后把包里的角色卡选择写回本地；只在用户确认导入之后调，别在解析阶段就改人设。 */
export function applyLorePack(content) {
  const info = describeLorePack(content);
  if (!info || !info.cardId) return null;
  return applyLoreSelection({ cardId: info.cardId });
}

/** 从 manifest 一路走到 snapshot。 */
export function extractSnapshot(manifest) {
  const parsed = manifest && manifest.manifest ? manifest.manifest : manifest;
  if (!parsed || parsed.format !== ARCHIVE_FORMAT) throw fail('INVALID_ARCHIVE_MANIFEST', '清单不对。');
  const { content } = parsePackage(parsed.package);
  // lore / loreHint 一并交出去：page-backup 要在确认框里说「这份包含角色卡」，
  // 确认之后再用 applyLorePack(content) 落盘；这里只解析不动状态。
  const lore = parseLore(content.lore);
  return { snapshot: parseSnapshot(content.snapshot), content, lore, loreHint: describeLorePack(content) };
}

/**
 * 导入后该打开哪个线程：旧包没有把「当前线程」放进资料包（那是 localStorage 的
 * ellen.mobile.thread-selection），所以按**最近一条消息所在的线程**推断。
 * 不做这一步的话，导入完打开是一片空白，看起来像数据丢了。
 */
export function pickRecentThread(heads) {
  let best = null;
  for (const h of heads) {
    if (h.kind !== 'message' || !h.threadId) continue;
    const t = Number.isFinite(h.messageTime) ? h.messageTime : h.createdAt || 0;
    if (!best || t > best.at) best = { at: t, threadId: h.threadId };
  }
  return best ? best.threadId : null;
}

/**
 * 灌库。默认**清空后重灌**（一次性迁移语义），传 { merge:true } 则保留现有记录。
 * 顺序照 M4 约定：profiles → revisions → heads，按 BATCH 分批。
 */
export async function importSnapshot(snapshot, { merge = false, onProgress } = {}) {
  const snap = parseSnapshot(snapshot);
  const { heads, revisions, stats } = rebuildHeads(snap.records);

  const db = await openDb();
  if (!merge) {
    const profiles = db.transaction([STORE_HEADS, STORE_REVISIONS], 'readwrite');
    profiles.objectStore(STORE_HEADS).clear();
    profiles.objectStore(STORE_REVISIONS).clear();
    await new Promise((resolve, reject) => {
      profiles.oncomplete = () => resolve();
      profiles.onerror = () => reject(profiles.error);
      profiles.onabort = () => reject(profiles.error);
    });
    const meta = db.transaction(STORE_PROFILES, 'readwrite');
    meta.objectStore(STORE_PROFILES).clear();
    await new Promise((resolve, reject) => {
      meta.oncomplete = () => resolve();
      meta.onerror = () => reject(meta.error);
    });
  }

  // 1) profiles
  if (snap.profiles.length) {
    await tx(STORE_PROFILES, 'readwrite', (t) => {
      const s = t.objectStore(STORE_PROFILES);
      for (const p of snap.profiles) if (p && typeof p.id === 'string') s.put(p);
    });
  }

  // 2) revisions
  for (let i = 0; i < revisions.length; i += BATCH) {
    const slice = revisions.slice(i, i + BATCH);
    await tx(STORE_REVISIONS, 'readwrite', (t) => {
      const s = t.objectStore(STORE_REVISIONS);
      for (const r of slice) s.put(r);
    });
    if (onProgress) onProgress({ stage: 'revisions', done: Math.min(i + BATCH, revisions.length), total: revisions.length });
  }

  // 3) heads
  for (let i = 0; i < heads.length; i += BATCH) {
    const slice = heads.slice(i, i + BATCH);
    await tx(STORE_HEADS, 'readwrite', (t) => {
      const s = t.objectStore(STORE_HEADS);
      for (const h of slice) s.put(h);
    });
    if (onProgress) onProgress({ stage: 'heads', done: Math.min(i + BATCH, heads.length), total: heads.length });
  }

  const kinds = {};
  for (const h of heads) kinds[h.kind] = (kinds[h.kind] || 0) + 1;

  // 换了一批 profile，缓存必须清，不然按旧 profileId 查索引是空的
  invalidateProfile();

  // 把「当前线程」指到最近活跃的那个，否则导入完打开是空的。
  // 合并导入时：原来那条线程若是个空壳（新装后自动建、一条消息都没有），也要切过去 ——
  // 不切的话导完打开还是空白，看起来像数据没进来（2026-11-13 换正式签名包时踩到）。
  const threadId = pickRecentThread(heads);
  const current = await getMeta('current-thread', null).catch(() => null);
  let shouldSwitch = !merge || !current;
  if (!shouldSwitch && current && threadId && current !== threadId) {
    const here = heads.filter((h) => h.kind === 'message' && h.threadId === current).length;
    if (here === 0) shouldSwitch = true;
  }
  if (threadId && shouldSwitch) {
    await putMeta('current-thread', threadId);
    await putMeta('current-thread-at', Date.now());
  }

  // 相处天数是按「最早一条消息」算的，导入后必须把它对齐到旧包的真实起点，
  // 否则相处天数会从导入那天重新数（看起来像「我们才认识一天」）。
  const firstMessage = heads
    .filter((h) => h.kind === 'message')
    .reduce((min, h) => {
      const t = Number.isFinite(h.messageTime) ? h.messageTime : h.createdAt || 0;
      return t && (!min || t < min) ? t : min;
    }, 0);
  if (firstMessage) await putMeta('first-message', firstMessage);

  return {
    ok: true,
    profiles: snap.profiles.length,
    heads: heads.length,
    revisions: revisions.length,
    dropped: stats.dropped,
    kinds,
    threadId,
  };
}

/** 回读校验：按 head id 取回 revisions 数量与末条 value，抽样比对。 */
export async function verifyImport(sampleSize = 20) {
  const db = await openDb();
  const headCount = await reqDone(db.transaction(STORE_HEADS).objectStore(STORE_HEADS).count());
  const revCount = await reqDone(db.transaction(STORE_REVISIONS).objectStore(STORE_REVISIONS).count());
  const lack = [];
  let checked = 0;
  await new Promise((resolve, reject) => {
    const t = db.transaction([STORE_HEADS, STORE_REVISIONS], 'readonly');
    const heads = t.objectStore(STORE_HEADS);
    const revs = t.objectStore(STORE_REVISIONS);
    let n = 0;
    const cur = heads.openCursor();
    cur.onerror = () => reject(cur.error);
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c || n >= sampleSize) {
        resolve();
        return;
      }
      n++;
      checked++;
      const head = c.value;
      for (const rid of head.revisions || []) {
        const r = revs.get(rid);
        r.onsuccess = () => {
          if (!r.result) lack.push({ headId: head.id, revisionId: rid });
        };
      }
      c.continue();
    };
  });
  return { headCount, revCount, sampled: checked, missing: lack.length, missingSample: lack.slice(0, 5) };
}
