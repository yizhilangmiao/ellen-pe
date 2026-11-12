// 导出资料包（.ellenpack）——import.js 的逆过程。
//
// 格式必须与 import.js / 旧包**逐字段对齐**，否则导出的包自己都读不回来：
//   manifest v1 = { format, version:1, package, files }                     恰好 4 键
//   package     = { content, checksum }                                     恰好 2 键
//   content     = { format, formatVersion:2, packageId, origin, exportedAt,
//                   snapshot, media, lore }                                 7 键 + 可选 lore
//   snapshot    = { schemaVersion:4, profiles, records }                    恰好 3 键
//   records[]   = 一次改动（revision），不是 head —— 导入端按 id 分组重放
//
// content.formatVersion 1 → 2（2026-11-13）：多了 lore（用哪张角色卡）。
// 为什么抬版本号而不是悄悄加一个键：老版本 App 的 parsePackage 是**严格键集**校验，
// 悄悄加键会让它报「资料包内容字段无效」——用户看到的是「包坏了」。抬版本后它报的是
// 「不支持此资料包格式或版本」，意思对，也不会让人以为数据丢了。
// 反过来老包（version 1、没有 lore）仍然能导入：import.js 认 1 和 2。
//
// schemaVersion 3 → 4（2026-11-12）：消息 value 里多了 type/recalled/quoteOf/segIndex/
// segCount/image/tone。新字段**就在 value 里原样带出去**（slimRevision 不裁 value），
// 所以这里只动版本号；老端读到认不出的字段会忽略，包不会因此读不回来。
//
// media.mode 两种：
//   'metadata-only' —— 只带元数据（旧包轻量版口径）
//   'include'       —— 连附件字节一起打（语音消息的 wav），上限见 ATTACH_MAX_BYTES
// 附件清单的 files[i] 只给 {id,name,sha256,sizeBytes}：字节由原生按 name 从
// filesDir/attachments/ 直接读，不过 JS 桥（100 MB base64 过桥会 OOM）。
// 早期写法（以下为历史注释）：
// 附件字节仍然留在设备上，换机只保留清单。要带字节得先把附件落成文件，
// 那是 M8 之后的事（见 _verify\M7-备份.md）。
import { STORE_HEADS, STORE_PROFILES, STORE_REVISIONS, count, openDb, reqDone } from './db.js';
import { ARCHIVE_FORMAT, CONTENT_FORMAT_VERSION, SNAPSHOT_SCHEMA_VERSION, TRANSFER_FORMAT } from './import.js';
import { deviceId, platform } from './records.js';
import { readDocument } from '../documents.js';
import { readLoreSelection } from '../lore.js';

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

/** 附件总量上限：100 MB（老大拍板）。超了按「新的优先」截断。 */
export const ATTACH_MAX_BYTES = 100 * 1024 * 1024;

/**
 * 收集要打进包的附件（目前只有语音消息的 wav）。
 *
 * 为什么在 web 侧算 sha256：原生写包时要按清单逐个校验，而原生能直接读
 * filesDir/attachments，所以只需清单里的 name + sha256 + sizeBytes；字节不过桥。
 * @returns {{ files: Array<{id:string,name:string,sha256:string,sizeBytes:number}>, bytes:number, skipped:number }}
 */
async function collectAttachments(records) {
  const seen = new Set();
  const wanted = [];
  // records 是按 revision 排的；语音消息的 revision 里才有 audio
  for (const r of records) {
    const audio = r && r.value && r.value.audio;
    if (!audio || !audio.name || audio.missing) continue;
    if (seen.has(audio.name)) continue;
    seen.add(audio.name);
    wanted.push({ name: audio.name, size: Number(audio.bytes) || 0 });
  }
  if (!wanted.length) return { files: [], bytes: 0, skipped: 0 };

  const files = [];
  let bytes = 0;
  let skipped = 0;
  // 新的优先：名字里带毫秒时间戳（voice-<ts>.wav），按它倒序；超上限时丢的是最老的
  const stampOf = (name) => {
    const m = /(\d{10,})/.exec(name);
    return m ? Number(m[1]) : 0;
  };
  wanted.sort((a, b) => stampOf(b.name) - stampOf(a.name));
  for (const item of wanted) {
    if (bytes + item.size > ATTACH_MAX_BYTES) {
      skipped += 1;
      continue;
    }
    let hex = '';
    try {
      const res = await readDocument(item.name);
      if (!res || !res.base64) {
        skipped += 1;
        continue;
      }
      hex = await sha256Base64(res.base64);
      const real = Number(res.bytes) || item.size;
      if (bytes + real > ATTACH_MAX_BYTES) {
        skipped += 1;
        continue;
      }
      bytes += real;
      files.push({
        id: item.name,
        name: item.name,
        sha256: hex,
        sizeBytes: real,
        mimeType: mimeOf(item.name),
      });
    } catch (err) {
      // 文件被清理/读不出：跳过，不整包失败（备份不该因为一条语音读不出就断）
      console.warn('[export] 附件读不出来，跳过', item.name, err);
      skipped += 1;
    }
  }
  return { files, bytes, skipped };
}

/** 附件扩展名 → MIME（导入侧会校验，空串会被拒）。目前只有语音。 */
function mimeOf(name) {
  const ext = String(name).toLowerCase().split('.').pop();
  if (ext === 'wav') return 'audio/wav';
  if (ext === 'mp3') return 'audio/mpeg';
  if (ext === 'ogg') return 'audio/ogg';
  if (ext === 'm4a') return 'audio/mp4';
  return 'application/octet-stream';
}

async function sha256Base64(base64) {
  const bin = atob(base64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) buf[i] = bin.charCodeAt(i);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 组出 snapshot + 完整 manifest 文本（含要一起打进去的附件清单）。 */
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

  // schemaVersion 与 import.js 的常量同源，改动只改一处（export.js 已经依赖 import.js，不新增环）
  const snapshot = { schemaVersion: SNAPSHOT_SCHEMA_VERSION, profiles: profiles.slice(), records };

  // 语音（及将来的聊天附件）要不要一起打：默认打，超上限就按「新的优先」截断，
  // 截掉的仍在库里、只是不进这个包 —— 用户看到的是 stats.attachmentsSkipped。
  const attachments = await collectAttachments(records);
  // lore：把「现在用的是哪张角色卡」一起带走。角色卡本身在包里没有字节（它在 bundle 里），
  // 这里只记选择——换手机后不该莫名其妙变回原作向。
  const lore = readLoreSelection();
  const content = {
    format: TRANSFER_FORMAT,
    formatVersion: CONTENT_FORMAT_VERSION,
    packageId: `pkg:${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    origin: { deviceId: deviceId(), platform: platform() },
    exportedAt: now,
    snapshot,
    media: { mode: attachments.files.length ? 'include' : 'metadata-only', requiredIds: [] },
    lore,
  };
  const contentText = JSON.stringify(content);
  const pkg = { content, checksum: await sha256Hex(contentText) };

  const manifest = {
    format: ARCHIVE_FORMAT,
    version: 1,
    package: pkg,
    files: attachments.files,
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
      attachments: attachments.files.length,
      attachmentsBytes: attachments.bytes,
      attachmentsSkipped: attachments.skipped,
      manifestBytes: new TextEncoder().encode(manifestText).length,
      loreCardId: lore.cardId,
    },
  };
}
