// 相册：只做「取一张图 / 存一张图」（原生 EllenMedia，契约 §2）。
//
// 四个必须做对的点：
//   1) 重入保护 —— 用户连点两下会开两个系统选择器；Android 上第二个把第一个顶掉，
//      回来的结果就对不上号了（看起来像「选了图却没发出去」）。原生那边会 reject MEDIA_BUSY，
//      这里在发请求之前就先拦住，不让它走一次跨进程。
//   2) 取消不是错误 —— 原生 resolve {picked:false}（不是 reject），这里原样透出，
//      调用方只看 res.picked，别写成 try/catch 里的异常分支。
//   3) uri 是 content://...fileprovider/photos/IMG_xxx.jpg，WebView 不能直接当 img src。
//      要显示必须走既有文档插件 EllenDocuments.open 取回字节，再拼 blob URL —— 这一步
//      由 src 字段和 imageSrc() 负责，调用方不需要知道细节。
//   4) 浏览器里（vite dev / 验收）没有壳也没有相册：返回 picked:false，不抛错。
//
// 字段为什么给两套名字：契约 §2 原生返回 {name, uri, mimeType, bytes, width, height}，
// 任务书要求 web 侧返回 {path, width, height, size, mime}。两边都有人按它写代码，
// 所以一次返回全部别名 —— 拿 path 或 uri 都能用，别让字段名变成协作成本。
import { call, isNative, requestId } from './native/bridge.js';
import { readDocument, toBlobUrl } from './documents.js';

/** 长边上限：1600 足够聊天里看清，又不会让一条消息几 MB。 */
export const DEFAULT_MAX_SIDE = 1600;

/** 压缩后字节上限：1.5 MB（1572864）。聊天记录要能整包导出，单张不能太大。 */
export const DEFAULT_MAX_BYTES = 1572864;

/** 正在选图中。并发进来直接回 picked:false，不开第二个选择器。 */
let picking = false;

/** 这台设备有没有相册能力（浏览器里 false）。 */
export function mediaSupported() {
  return isNative();
}

/** content://.../photos/IMG_1.jpg 或 /data/.../IMG_1.jpg → IMG_1.jpg */
function basenameOf(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  const cut = text.split(/[?#]/)[0];
  const parts = cut.split('/');
  return parts[parts.length - 1] || '';
}

/**
 * 把 native 的 uri 变成能在 <img src> 里用的 URL。
 * @param {string} uri content:// 或 file:// 或纯文件名
 * @returns {Promise<string>} 失败回空串（调用方显示占位，不弹错）
 */
export async function imageSrc(uri) {
  const key = String(uri || '').trim();
  if (!key) return '';
  if (key.startsWith('data:') || key.startsWith('blob:')) return key;
  try {
    const res = await readDocument(key);
    if (!res || !res.base64) return '';
    return toBlobUrl(res.base64, res.mimeType || 'image/jpeg', `img:${key}`);
  } catch (err) {
    // 附件被 200MB 清理删掉了 / 权限被撤了：都只是「这张图看不了了」
    return '';
  }
}

/** 把原生返回收成一份稳定的对象（取消也走这里，picked 为 false）。 */
function normalizePicked(res) {
  const base = { picked: false };
  if (!res || res.picked === false) return base;
  const uri = String(res.uri || res.path || '');
  if (!uri) return base;
  const bytes = Number(res.bytes || res.size || 0);
  const mime = String(res.mimeType || res.mime || 'image/jpeg');
  const name = String(res.name || basenameOf(uri));
  return {
    picked: true,
    uri,
    // path 是任务书的名字，uri 是契约的名字：同一个值
    path: uri,
    name,
    width: Number(res.width || 0),
    height: Number(res.height || 0),
    size: bytes,
    bytes,
    mime,
    mimeType: mime,
    // 可渲染地址（content:// 不能进 img src）。取图失败时是空串，气泡走占位。
    src: '',
  };
}

/**
 * 让用户从相册挑一张图（原生压缩到长边 maxSide、字节 maxBytes 后落进 App 文档目录）。
 * @param {{maxSide?:number, maxBytes?:number, withSrc?:boolean}} [opts]
 *        withSrc 默认 true：顺手取回字节拼好 src，发出去就能立刻看见缩略图
 * @returns {Promise<{picked:boolean, uri?:string, path?:string, name?:string, width?:number,
 *           height?:number, size?:number, bytes?:number, mime?:string, mimeType?:string, src?:string,
 *           reason?:string}>}
 *          picked:false = 用户取消 / 浏览器环境 / 上一次还没回来 / 出错（都不抛）
 */
export async function pickImage(opts = {}) {
  if (!isNative()) return { picked: false, reason: 'NOT_NATIVE' };
  if (picking) return { picked: false, reason: 'BUSY' };
  const maxSide = Number(opts.maxSide) > 0 ? Math.round(Number(opts.maxSide)) : DEFAULT_MAX_SIDE;
  const maxBytes = Number(opts.maxBytes) > 0 ? Math.round(Number(opts.maxBytes)) : DEFAULT_MAX_BYTES;
  picking = true;
  try {
    const res = await call('EllenMedia', 'pickImage', {
      requestId: requestId('pick'),
      maxSide,
      maxBytes,
    });
    const picked = normalizePicked(res);
    if (!picked.picked) return picked;
    if (opts.withSrc !== false) picked.src = await imageSrc(picked.uri);
    return picked;
  } catch (err) {
    const code = String((err && err.code) || '');
    // MEDIA_BUSY 是「上一次还没回来」，不是故障，别报给用户
    if (code && code !== 'MEDIA_BUSY') console.warn('[media] 选图失败', code, err);
    return { picked: false, reason: code || 'MEDIA_PICK_FAILED' };
  } finally {
    picking = false;
  }
}

/** 只要成功结果、其余一律 null 的薄包装（懒调用方用这个，少写一层 picked 判断）。 */
export async function pickImageOrNull(opts = {}) {
  const res = await pickImage(opts);
  return res && res.picked ? res : null;
}

/**
 * 把一张图存回系统相册。
 * 原生只认 photos/ 与 attachments/ 下的**文件名**，不收绝对路径 —— 所以这里只挑 name 传过去。
 * @param {{name?:string, uri?:string, path?:string, mimeType?:string, mime?:string}|string} input
 *        可以直接给消息里的 msg.image，也可以给 uri / name 字符串
 * @returns {Promise<{saved:boolean, name:string, code?:string, message?:string}>}
 *          saved:false 不抛错，code 沿用原生语义（MEDIA_NOT_FOUND / MEDIA_PERMISSION / MEDIA_WRITE_FAILED）
 */
export async function saveToAlbum(input) {
  const raw = typeof input === 'string' ? { name: input } : input || {};
  const uri = String(raw.uri || raw.path || '');
  const name = String(raw.name || '') || basenameOf(uri);
  if (!name) return { saved: false, name: '', code: 'MEDIA_NOT_FOUND' };
  if (!isNative()) return { saved: false, name, code: 'MEDIA_NOT_SUPPORTED' };
  try {
    const res = await call('EllenMedia', 'saveToAlbum', {
      requestId: requestId('save'),
      name,
      mimeType: String(raw.mimeType || raw.mime || 'image/jpeg'),
    });
    return { saved: !!(res && res.saved !== false), name };
  } catch (err) {
    return {
      saved: false,
      name,
      code: String((err && err.code) || 'MEDIA_WRITE_FAILED'),
      message: String((err && err.message) || err),
    };
  }
}
