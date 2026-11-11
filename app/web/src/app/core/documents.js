// 附件落盘：原生 EllenDocuments 的薄封装。
//
// 原生契约（EllenDocumentsPlugin.kt，已核实）：
//   save({name, base64}) -> {uri, name, bytes, mimeType}，单次上限 32 MiB
//   open({uri})          -> {base64, bytes, name, mimeType}
//   remove({uri})        -> {removed}
//   stat({uri})          -> {exists, bytes, mtime, name}
//
// 为什么不塞 IndexedDB：一条语音 1~2 MB，base64 塞进消息记录会把整库撑爆，
// 而且 blob URL 重启即失效。文件落盘 + 按需读回才是长久的；库里只存 uri/name/bytes。
import { call } from './native/bridge.js';

export const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;

/** data:audio/wav;base64,xxxx 这种前缀一律剥掉，原生只吃纯 base64。 */
export function stripDataUrl(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  if (raw.slice(0, 5) !== 'data:') return raw;
  const comma = raw.indexOf(',');
  return comma > 0 ? raw.slice(comma + 1) : '';
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(stripDataUrl(String(reader.result || '')));
    reader.onerror = () => reject(Object.assign(new Error('读这个文件失败。'), { code: 'DOCUMENT_READ_LOCAL_FAILED' }));
    reader.readAsDataURL(blob);
  });
}

/** 存一个文件，返回 {uri, name, bytes, mimeType}。name 只是前缀，原生会自己加 id。 */
export async function saveDocument(blobOrBase64, name = 'attachment') {
  let base64 = '';
  if (typeof blobOrBase64 === 'string') base64 = stripDataUrl(blobOrBase64);
  else if (blobOrBase64 instanceof Blob) base64 = await blobToBase64(blobOrBase64);
  if (!base64) throw Object.assign(new Error('附件是空的。'), { code: 'DOCUMENT_EMPTY' });
  const res = await call('EllenDocuments', 'save', { name, base64 });
  return {
    uri: (res && res.uri) || '',
    name: (res && res.name) || '',
    bytes: Number((res && res.bytes) || 0),
    mimeType: (res && res.mimeType) || '',
  };
}

/** 读回一个附件：{base64, bytes, name, mimeType}。找不到就抛 DOCUMENT_NOT_FOUND。 */
export async function readDocument(uri) {
  const key = String(uri || '').trim();
  if (!key) throw Object.assign(new Error('没有给附件地址。'), { code: 'DOCUMENT_INVALID_URI' });
  const res = await call('EllenDocuments', 'open', { uri: key });
  return {
    base64: (res && res.base64) || '',
    bytes: Number((res && res.bytes) || 0),
    name: (res && res.name) || '',
    mimeType: (res && res.mimeType) || '',
  };
}

/** 删一个附件。删不掉只留日志，别把消息也弄丢。 */
export async function removeDocument(uri) {
  const key = String(uri || '').trim();
  if (!key) return false;
  try {
    const res = await call('EllenDocuments', 'remove', { uri: key });
    return !!(res && res.removed);
  } catch (err) {
    console.warn('[documents] 删附件失败', err);
    return false;
  }
}

/** 问一下还在不在：{exists, bytes, mtime, name}。 */
export async function documentStat(uri) {
  const key = String(uri || '').trim();
  if (!key) return { exists: false, bytes: 0, mtime: 0, name: '' };
  try {
    const res = await call('EllenDocuments', 'stat', { uri: key });
    return {
      exists: !!(res && res.exists),
      bytes: Number((res && res.bytes) || 0),
      mtime: Number((res && res.mtime) || 0),
      name: (res && res.name) || '',
    };
  } catch (err) {
    return { exists: false, bytes: 0, mtime: 0, name: '' };
  }
}

// —— base64 -> blob URL 缓存 ——
// 同一条语音反复点不该反复解码（1.9 MB 的 base64 解一次几十毫秒）。
// 缓存键默认用「长度 + 首尾 24 字符」，调用方有稳定 id（uri）时传第三参更准。
const blobUrls = new Map();

function cacheKey(base64, mime) {
  return `${mime}:${base64.length}:${base64.slice(0, 24)}:${base64.slice(-24)}`;
}

function bytesOf(base64) {
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export function toBlobUrl(base64, mime = 'audio/wav', key = '') {
  const raw = stripDataUrl(base64);
  if (!raw) return '';
  const k = key || cacheKey(raw, mime);
  const hit = blobUrls.get(k);
  if (hit) return hit;
  const url = URL.createObjectURL(new Blob([bytesOf(raw)], { type: mime || 'audio/wav' }));
  blobUrls.set(k, url);
  return url;
}

/** 视图销毁时把所有 blob URL 撤掉（不撤会一路常驻，播过的每条都在）。 */
export function revokeAll() {
  blobUrls.forEach((url) => {
    try { URL.revokeObjectURL(url); } catch (err) { /* 已释放就忽略 */ }
  });
  blobUrls.clear();
}

/** 测试/验收探针用：看缓存里有几个 URL。 */
export function blobUrlCount() {
  return blobUrls.size;
}

/** 列附件目录（原生只列一层、按 mtime 新→旧、上限 5000 条、*.part 不计入只算 skipped）。
 *  排序与「删谁」的策略留在 web 层：200 MB 阈值以后还要调，不该烧进 Kotlin。
 *  注意：目录读不到时原生回空表、不 reject，所以这里也不抛。 */
export async function listDocuments({ prefix = '' } = {}) {
  const args = prefix ? { prefix } : {};
  const res = await call('EllenDocuments', 'list', args);
  const files = Array.isArray(res && res.files) ? res.files : [];
  return {
    files: files.map((f) => ({
      name: String(f.name || ''),
      bytes: Number(f.bytes || 0),
      mtime: Number(f.mtime || 0),
      uri: String(f.uri || ''),
    })),
    count: Number((res && res.count) || files.length),
    totalBytes: Number((res && res.totalBytes) || 0),
    skipped: Number((res && res.skipped) || 0),
    truncated: Boolean(res && res.truncated),
  };
}
