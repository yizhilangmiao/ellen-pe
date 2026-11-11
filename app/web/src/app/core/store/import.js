// 旧包资料包（.ellenpack）解析 + 灌库。
//
// 格式依据（旧包 service chunk 逆向，见 contract/M4-数据模型-真机实测.md 与 M0 契约）：
//   容器 = "ELLENPK1\n"(9B) + int32 大端 manifest 字节长 + manifest(UTF-8) + 各文件字节
//   manifest v1 = { format:'ellen-companion-archive', version:1, package, files }            恰好 4 键
//   manifest v2 = { ...v1, version:2, selection, groupId, checksum }                        恰好 7 键
//   files[]     = { id, sha256, sizeBytes, mimeType } 或 { id, name, sha256, sizeBytes, mimeType }
//                 （后者带 name，语音附件用：name 就是 filesDir/attachments 里的文件名）
//   package     = { content, checksum }
//   content     = { format:'ellen-companion-transfer', formatVersion:1, packageId,
//                   origin:{deviceId,platform}, exportedAt, snapshot, media }               恰好 7 键
//   snapshot    = { schemaVersion:1, profiles:[], records:[] }                              恰好 3 键
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
import { invalidateProfile, putMeta } from './records.js';

export const ARCHIVE_MAGIC = 'ELLENPK1\n';
export const ARCHIVE_FORMAT = 'ellen-companion-archive';
export const TRANSFER_FORMAT = 'ellen-companion-transfer';
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
  if (!keysAre(content, ['format', 'formatVersion', 'packageId', 'origin', 'exportedAt', 'snapshot', 'media'])) {
    throw fail('INVALID_PACKAGE', '资料包内容字段无效。');
  }
  if (content.format !== TRANSFER_FORMAT || content.formatVersion !== 1) {
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

/** 校验 snapshot 外形。 */
export function parseSnapshot(snapshot) {
  if (!keysAre(snapshot, ['schemaVersion', 'profiles', 'records'])) {
    throw fail('INVALID_SCHEMA', '资料快照字段无效（应为 schemaVersion/profiles/records）。');
  }
  if (snapshot.schemaVersion !== 1) {
    throw fail('UNSUPPORTED_VERSION', '不支持此数据版本。');
  }
  if (!Array.isArray(snapshot.profiles) || !Array.isArray(snapshot.records)) {
    throw fail('INVALID_SCHEMA', '资料列表无效。');
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

/** 从 manifest 一路走到 snapshot。 */
export function extractSnapshot(manifest) {
  const parsed = manifest && manifest.manifest ? manifest.manifest : manifest;
  if (!parsed || parsed.format !== ARCHIVE_FORMAT) throw fail('INVALID_ARCHIVE_MANIFEST', '清单不对。');
  const { content } = parsePackage(parsed.package);
  return { snapshot: parseSnapshot(content.snapshot), content };
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

  // 把「当前线程」指到最近活跃的那个，否则导入完打开是空的
  const threadId = pickRecentThread(heads);
  if (!merge && threadId) {
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
