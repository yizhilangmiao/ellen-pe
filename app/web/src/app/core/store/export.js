// 导出资料包（.ellenpack）——import.js 的逆过程。
//
// 格式必须与 import.js / 旧包**逐字段对齐**，否则导出的包自己都读不回来：
//   manifest v1 = { format, version:1, package, files }                     恰好 4 键
//   package     = { content, checksum }                                     恰好 2 键
//   content     = { format, formatVersion:1, packageId, origin, exportedAt,
//                   snapshot, media }                                       恰好 7 键
//   snapshot    = { schemaVersion:1, profiles, records }                    恰好 3 键
//   records[]   = 一次改动（revision），不是 head —— 导入端按 id 分组重放
//
// 本版 media 只带元数据（media.mode = 'metadata-only'），与旧包轻量版一致：
// 附件字节仍然留在设备上，换机只保留清单。要带字节得先把附件落成文件，
// 那是 M8 之后的事（见 _verify\M7-备份.md）。
import { STORE_HEADS, STORE_PROFILES, STORE_REVISIONS, count, openDb, reqDone } from './db.js';
import { ARCHIVE_FORMAT, TRANSFER_FORMAT } from './import.js';
import { deviceId, platform } from './records.js';

/** 一屏读多少条（大库靠游标分页，别一次全拉进内存炸掉 WebView）。 */
const PAGE = 2000;

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** 游标分页读整张表。 */
async function readAll(storeName) {
  const db = await openDb();
  const out = [];
  await new Promise((resolve, reject) => {
    const t = db.transaction(storeName, 'readonly');
    const cur = t.objectStore(storeName).openCursor();
    cur.onerror = () => reject(cur.error);
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) {
        resolve();
        return;
      }
      out.push(c.value);
      // 别在这里 setTimeout 让帧：IndexedDB 的事务在宏任务之间会提交，
      // 之后 c.continue() 抛 TransactionInactiveError，Promise 永远不 settle（踩过，卡了 300 s）。
      c.continue();
    };
  });
  return out;
}

/** 只导出导入端认得的字段，顺序固定（便于 diff 与排错）。 */
function slimRevision(r, headId) {
  return {
    id: headId || r.id || '',
    revisionId: r.revisionId || '',
    kind: r.kind || 'unknown',
    profileId: r.profileId || '',
    parents: Array.isArray(r.parents) ? r.parents.filter((x) => typeof x === 'string') : [],
    origin: r.origin && typeof r.origin === 'object'
      ? { deviceId: String(r.origin.deviceId || ''), platform: String(r.origin.platform || '') }
      : { deviceId: '', platform: '' },
    at: Number.isFinite(r.at) ? r.at : 0,
    deleted: r.deleted === true,
    value: r.value === undefined ? null : r.value,
    refs: Array.isArray(r.refs) ? r.refs : [],
  };
}

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 库里现在有多少东西（设置页显示用，不读 value，快）。 */
export async function stats() {
  const [heads, revisions, profiles] = await Promise.all([
    count(STORE_HEADS),
    count(STORE_REVISIONS),
    count(STORE_PROFILES),
  ]);
  return { heads, revisions, profiles };
}

/**
 * 组出 snapshot + 完整 manifest 文本。
 * @returns {{ manifestText: string, manifest: object, stats: object }}
 */
export async function buildManifest({ now = Date.now() } = {}) {
  const [heads, revisions, profiles] = await Promise.all([
    readAll(STORE_HEADS),
    readAll(STORE_REVISIONS),
    readAll(STORE_PROFILES),
  ]);
  if (!Array.isArray(heads) || !Array.isArray(revisions)) {
    throw fail('EXPORT_FAILED', '读不出库里的记录。');
  }

  // revision 自带 head id（records.js 写库时同一字段），heads 只用来对账
  const headIds = new Set(heads.map((h) => h.id));
  const records = revisions
    .filter((r) => r && typeof r.revisionId === 'string' && r.revisionId && headIds.has(r.id))
    .map((r) => slimRevision(r, r.id));

  const kinds = {};
  for (const r of records) kinds[r.kind] = (kinds[r.kind] || 0) + 1;

  const snapshot = { schemaVersion: 1, profiles: profiles.slice(), records };

  const content = {
    format: TRANSFER_FORMAT,
    formatVersion: 1,
    packageId: `pkg:${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    origin: { deviceId: deviceId(), platform: platform() },
    exportedAt: now,
    snapshot,
    media: { mode: 'metadata-only', requiredIds: [] },
  };
  const contentText = JSON.stringify(content);
  const pkg = { content, checksum: await sha256Hex(contentText) };

  const manifest = {
    format: ARCHIVE_FORMAT,
    version: 1,
    package: pkg,
    files: [],
  };
  const manifestText = JSON.stringify(manifest);

  return {
    manifestText,
    manifest,
    stats: {
      heads: heads.length,
      revisions: revisions.length,
      profiles: profiles.length,
      records: records.length,
      kinds,
      manifestBytes: new TextEncoder().encode(manifestText).length,
    },
  };
}
