// 自定义表情库（排期2 §3）：用户导入的图，她也能拿来发。
//
// 这个模块只做三件事，边界故意划得很窄：
//   1) 清单（meta `ellen.stickers.v1`）—— 条目形状、200 张上限、增删；
//   2) 字节进出原生 —— 导入 / 读回 / 删除都落在 EllenMediaPlugin，不在 JS 里解码大图；
//   3) 候选池 —— 给「她回一张表情」用的纯函数（pickCustomForSlot / ownedCandidates）。
//
// 为什么清单在 web 层而不在原生：
//   meta 表跟着消息库一起备份/迁移，用户换手机时表情清单和聊天记录得一起走；
//   原生只管字节（filesDir/stickers/），不掺和「哪张是第几个、属于哪个 slot」。
//
// 为什么 URL 一律 blob：
//   filesDir 下的文件 WebView 打不开，FileProvider 的 content:// 也不能直接当 img src，
//   必须取回字节再拼 blob URL（core/media.js 顶上那段注释讲过同一条经验）。
//
// 为什么这个模块不 import assets/stickers.js：
//   依赖方向只能单向（assets → 这里）。反过来引会成环，而且 stickers.js 在启动时就要
//   能兜底查自定义 id，它不该为了拿一条记录把整个原生桥拖进来。
import { call, isNative } from './native/bridge.js';
import { getMeta, putMeta } from './store/records.js';

/** 清单键。改这个键 = 用户已导入的表情全部「消失」，所以带版本号且永不改名。 */
export const CUSTOM_META_KEY = 'ellen.stickers.v1';

/** 自定义 id 前缀。和包内 `s001…s228` 天然不撞，stickerById 靠它分流。 */
export const CUSTOM_ID_PREFIX = 'u:';

/** 硬指标三条（和 EllenMediaPlugin 的 STICKER_MAX_SIDE / STICKER_MAX_BYTES 必须一致）。 */
export const MAX_CUSTOM_STICKERS = 200;
export const MAX_STICKER_SIDE = 512;
export const MAX_STICKER_BYTES = 300 * 1024;

/** 清单版本。将来结构变了靠它迁移，不靠猜字段。 */
export const CUSTOM_SCHEMA_VERSION = 1;

/** 同时留多少个 blob URL。200 张全展开也不过几百 KB 的 DOM，但 URL 多了会一直占内存。 */
const MAX_LIVE_URLS = 48;

/** 清单里的一条：{id,name,mimeType,width,height,bytes,at,slot,label,animated} */
let items = [];
/** 收藏：她发过、并被认定「可以用」的表情 id 列表（含包内 s0xx）。 */
let kept = [];

let loaded = false;
let loading = null;
/** meta 读成功过没有。读失败时绝不能拿空清单去对账，否则会把磁盘上的文件当孤儿删光。 */
let metaTrusted = false;

const urls = new Map();
const pending = new Map();
const listeners = new Set();

export class StickerError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'StickerError';
    this.code = code;
  }
}

function failed(code, message) {
  return new StickerError(code, message);
}

export function isCustomStickerId(id) {
  return String(id || '').startsWith(CUSTOM_ID_PREFIX);
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name || '');
  const id = String(raw.id || '');
  if (!name || !id.startsWith(CUSTOM_ID_PREFIX)) return null;
  return {
    id,
    name,
    mimeType: String(raw.mimeType || ''),
    width: Number(raw.width) || 0,
    height: Number(raw.height) || 0,
    bytes: Number(raw.bytes) || 0,
    at: Number(raw.at) || 0,
    slot: String(raw.slot || ''),
    label: String(raw.label || ''),
    animated: raw.animated === true,
  };
}

async function doLoad() {
  try {
    const raw = await getMeta(CUSTOM_META_KEY, null);
    const data = raw && typeof raw === 'object' ? raw : {};
    items = Array.isArray(data.items) ? data.items.map(normalizeItem).filter(Boolean) : [];
    kept = Array.isArray(data.kept)
      ? data.kept
          .filter((k) => k && typeof k === 'object' && k.id)
          .map((k) => ({ id: String(k.id), slot: String(k.slot || ''), at: Number(k.at) || 0 }))
      : [];
    metaTrusted = Array.isArray(data.items) || raw == null;
  } catch (err) {
    // 库没开起来也能用：清单当作空，但 metaTrusted=false，下面不删磁盘上的任何东西
    console.warn('[stickers] 读清单失败', err);
    items = [];
    kept = [];
    metaTrusted = false;
  }
  // 超过 200 张的历史数据（旧版本没拦）只留前 200，别在界面上崩掉
  if (items.length > MAX_CUSTOM_STICKERS) items = items.slice(0, MAX_CUSTOM_STICKERS);
  loaded = true;
  if (metaTrusted) reconcile().catch(() => {});
}

/**
 * 第一次访问时读清单。并发进来共用同一个 Promise ——
 * 面板一开就会同时要 8 个格子的 URL，各读一次 meta 是 8 次事务。
 */
export async function ensureCustomStickers() {
  if (loaded) return items.slice();
  if (!loading) {
    loading = doLoad().finally(() => {
      loading = null;
    });
  }
  await loading;
  return items.slice();
}

/** 同步拿清单（调用前先 ensureCustomStickers()）。面板渲染走这个，别在渲染里 await。 */
export function customStickers() {
  return items.slice();
}

export function customStickerById(id) {
  const key = String(id || '');
  return items.find((it) => it.id === key) || null;
}

/** 清单变化订阅（导入、删除、收藏都用它驱动重绘）。返回取消函数。 */
export function onCustomStickersChange(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  listeners.forEach((fn) => {
    try {
      fn(customStickers());
    } catch (err) {
      console.warn('[stickers] 订阅者异常', err);
    }
  });
}

async function save() {
  await putMeta(CUSTOM_META_KEY, {
    version: CUSTOM_SCHEMA_VERSION,
    items,
    kept,
  });
}

async function reconcile() {
  let files = null;
  try {
    const res = await call('EllenMedia', 'listStickers', {});
    files = Array.isArray(res && res.files) ? res.files : null;
  } catch (err) {
    return; // 列不出来就不动任何东西（宁可留一张孤儿文件，也不要误删用户的表情）
  }
  if (!files) return;
  const onDisk = new Set(files.map((f) => String(f.name || '')));
  const before = items.length;
  items = items.filter((it) => onDisk.has(it.name));
  // 磁盘上有、清单里没有的：只可能是「导入写盘成功后进程被杀」留下的残渣，
  // 而且必须是原生自己起名的 u_ 前缀文件才敢删（别的手滑放进去的不管）
  const known = new Set(items.map((it) => it.name));
  const orphans = files
    .map((f) => String(f.name || ''))
    .filter((n) => n.startsWith('u_') && !known.has(n));
  orphans.forEach((name) => {
    call('EllenMedia', 'deleteSticker', { name }).catch(() => {});
  });
  if (items.length !== before || orphans.length) {
    await save().catch(() => {});
    emit();
  }
}

/**
 * 导入一张：系统选择器 → 原生复制/缩放到 stickers/ → 记账。
 *
 * @param {{slot?:string,label?:string}} [opts] slot 用于「她按情绪挑图」，label 是给人看的名
 * @returns {Promise<object|null>} 用户取消返回 null；成功返回新条目
 */
export async function importCustomSticker({ slot = '', label = '' } = {}) {
  await ensureCustomStickers();
  if (!isNative()) throw failed('STICKER_NO_NATIVE', '这台设备没有相册能力。');
  // 200 张上限的第一道闸：在调原生之前拦，别让用户挑完图才被告知「满了」
  if (items.length >= MAX_CUSTOM_STICKERS) {
    throw failed('STICKER_LIMIT', `最多存 ${MAX_CUSTOM_STICKERS} 张，先删几张吧。`);
  }
  const res = await call('EllenMedia', 'importSticker', {
    maxSide: MAX_STICKER_SIDE,
    maxBytes: MAX_STICKER_BYTES,
  });
  if (!res || res.picked === false) return null;

  const name = String(res.name || '');
  if (!name) throw failed('STICKER_BAD_RESULT', '原生没给出文件名。');

  // 第二道闸：原生已经压过一遍，这里再核一次回包 —— 桥那头的数字不该被无条件相信
  const bytes = Number(res.bytes) || 0;
  const width = Number(res.width) || 0;
  const height = Number(res.height) || 0;
  if (bytes > MAX_STICKER_BYTES || Math.max(width, height) > MAX_STICKER_SIDE) {
    call('EllenMedia', 'deleteSticker', { name }).catch(() => {});
    throw failed('STICKER_TOO_LARGE', `单张要 ≤${MAX_STICKER_SIDE}px、≤${MAX_STICKER_BYTES / 1024}KB。`);
  }
  if (items.some((it) => it.name === name)) {
    // 同一毫秒重名（理论上不会发生）：当成功但不重复记账
    return customStickerById(`${CUSTOM_ID_PREFIX}${name}`);
  }

  const entry = {
    id: `${CUSTOM_ID_PREFIX}${name}`,
    name,
    mimeType: String(res.mimeType || ''),
    width,
    height,
    bytes,
    at: Date.now(),
    slot: String(slot || ''),
    label: String(label || ''),
    animated: res.animated === true,
  };
  items = [entry, ...items];
  await save();
  emit();
  return entry;
}

/**
 * 删一张：磁盘真删（原生 deleteSticker），清单同步去掉。
 * 用户导入的东西没有「回收站」的价值，只有「越堆越大」的风险。
 */
export async function deleteCustomSticker(id) {
  await ensureCustomStickers();
  const key = String(id || '');
  const item = items.find((it) => it.id === key);
  if (!item) return false;
  try {
    await call('EllenMedia', 'deleteSticker', { name: item.name });
  } catch (err) {
    // 文件已经不在了也算删成功：清单留着才是问题（界面上一张点了没反应的格子）
    console.warn('[stickers] 删文件失败，仍从清单移除', err);
  }
  items = items.filter((it) => it.id !== key);
  kept = kept.filter((k) => k.id !== key);
  releaseUrl(key);
  await save();
  emit();
  return true;
}

/**
 * 拿一张自定义表情的 blob URL（异步、带缓存）。
 * 面板/气泡里请配合 customStickerUrlSync() 先占位，等 Promise 回来再贴 src。
 */
export async function customStickerUrl(id) {
  const key = String(id || '');
  if (!isCustomStickerId(key)) return '';
  const hit = urls.get(key);
  if (hit) return hit;
  const waiting = pending.get(key);
  if (waiting) return waiting;

  const item = customStickerById(key);
  if (!item) return '';
  const task = (async () => {
    const res = await call('EllenMedia', 'readSticker', { name: item.name });
    const base64 = String((res && res.base64) || '');
    if (!base64) return '';
    const url = blobUrlOf(base64, String((res && res.mimeType) || item.mimeType || 'image/webp'));
    if (!url) return '';
    urls.set(key, url);
    trimUrls();
    return url;
  })()
    .catch((err) => {
      console.warn('[stickers] 读表情失败', item.name, err);
      return '';
    })
    .finally(() => {
      pending.delete(key);
    });
  pending.set(key, task);
  return task;
}

/** 已经加载过的 URL（同步）。没有就返回空串，调用方自己决定是占位还是等。 */
export function customStickerUrlSync(id) {
  return urls.get(String(id || '')) || '';
}

/** 预取若干张（打开面板时一次备好当前页，省得每格亮一下）。 */
export function prefetchCustomStickers(ids) {
  (ids || []).forEach((id) => {
    customStickerUrl(id).catch(() => {});
  });
}

function blobUrlOf(base64, mime) {
  try {
    const bin = atob(base64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([arr], { type: mime || 'application/octet-stream' }));
  } catch (err) {
    console.warn('[stickers] 拼 blob URL 失败', err);
    return '';
  }
}

function trimUrls() {
  while (urls.size > MAX_LIVE_URLS) {
    const oldest = urls.keys().next().value;
    releaseUrl(oldest);
  }
}

function releaseUrl(id) {
  const url = urls.get(id);
  if (!url) return;
  urls.delete(id);
  try {
    URL.revokeObjectURL(url);
  } catch (err) {
    /* 已经释放就忽略 */
  }
}

/** 视图销毁时调用：不撤会一路常驻（一条表情 300KB，全留着就是几十 MB）。 */
export function releaseCustomUrls() {
  [...urls.keys()].forEach(releaseUrl);
}

// ───────────────────────── 收藏（她发过的哪张「可以用」） ─────────────────────────

/** 收藏里是否已有这一张。 */
export function isKept(id) {
  const key = String(id || '');
  return kept.some((k) => k.id === key);
}

/** 收藏/取消收藏。返回收藏后的状态。 */
export async function toggleKeepSticker(id, { slot = '' } = {}) {
  await ensureCustomStickers();
  const key = String(id || '');
  if (!key) return false;
  if (isKept(key)) {
    kept = kept.filter((k) => k.id !== key);
  } else {
    kept = [{ id: key, slot: String(slot || ''), at: Date.now() }, ...kept].slice(
      0,
      MAX_CUSTOM_STICKERS * 2,
    );
  }
  await save();
  emit();
  return isKept(key);
}

/** 收藏列表（给「我的」页做排序用）。 */
export function keptStickers() {
  return kept.map((k) => ({ ...k }));
}

/**
 * 性格权重（纯函数，便于单测）：她「会想再发一次」的概率。
 *
 * 0.5 那一份是情绪对得上：mood 和这张图的 slot 同义（比如她这轮是「开心」，
 * 图也是「开心」），她用得顺手，收藏它是自然行为。
 * src=custom 再加 0.2：用户亲手导入的图，她挑中过就说明合胃口。
 * 没有 mood 时直接给 0 —— 没有情绪证据就别替用户做主（这是「别自作主张」的具体化）。
 */
export const AUTO_KEEP_BASE = 0.15;
export const AUTO_KEEP_MOOD_BONUS = 0.5;
export const AUTO_KEEP_CUSTOM_BONUS = 0.2;

export function autoKeepScore({ mood = '', slot = '', src = 'builtin' } = {}) {
  const m = String(mood || '');
  const s = String(slot || '');
  if (!m) return 0;
  let score = AUTO_KEEP_BASE;
  if (s && (m === s || m.indexOf(s) >= 0 || s.indexOf(m) >= 0)) score += AUTO_KEEP_MOOD_BONUS;
  if (src === 'custom') score += AUTO_KEEP_CUSTOM_BONUS;
  return Math.min(1, score);
}

/**
 * 自动收藏判定（纯函数）。
 * @param {{mood?:string, slot?:string, src?:'builtin'|'custom', roll?:number}} p
 * @returns {boolean}
 */
export function shouldAutoKeep({ mood = '', slot = '', src = 'builtin', roll = Math.random() } = {}) {
  const score = autoKeepScore({ mood, slot, src });
  if (score <= 0) return false;
  return roll < score;
}

/**
 * 她发了一张表情之后的记账口：按性格决定要不要收藏。
 * 界面不要自己判断「该不该存」——判断在这儿，UI 只负责调用。
 */
export async function noteHerSticker({ id, slot = '', src = 'builtin', mood = '', roll } = {}) {
  if (!id) return false;
  await ensureCustomStickers();
  if (isKept(id)) return false;
  if (!shouldAutoKeep({ mood, slot, src, roll: roll === undefined ? Math.random() : roll })) {
    return false;
  }
  return toggleKeepSticker(id, { slot });
}

// ───────────────────────── 候选池（给 sticker-reply.js 用） ─────────────────────────

/**
 * 她可以发出去的自定义表情。
 * @returns {Array<{id:string,file:string,label:string,slot:string}>}
 *   id 带 `u:` 前缀、file 是磁盘文件名、label 可能为空（界面用 id 兜底）
 *   —— 形状和 STICKER_FAVORITES 的条目一致，方便和包内池合并。
 */
export function ownedCandidates() {
  return items.map((it) => ({
    id: it.id,
    file: it.name,
    label: it.label || '',
    slot: it.slot || '',
  }));
}

/**
 * 她回表情时从自定义池里挑一张（纯函数，roll 可注入 → 好测）。
 * 选池顺序：同 slot → 收藏过的 → 全部。都没有返回 null，调用方保持原行为。
 *
 * @param {string} slot 收到的那个表情的 slot（空串 = 不知道）
 * @param {number} [roll] 0~1 的骰子
 * @returns {{id:string,file:string,label:string,slot:string}|null}
 */
export function pickCustomForSlot(slot = '', roll = Math.random()) {
  const all = ownedCandidates();
  if (!all.length) return null;
  const want = String(slot || '');
  const sameSlot = want ? all.filter((c) => c.slot && c.slot === want) : [];
  const favorited = all.filter((c) => isKept(c.id));
  const pool = sameSlot.length ? sameSlot : favorited.length ? favorited : all;
  const idx = Math.min(pool.length - 1, Math.max(0, Math.floor(roll * pool.length)));
  return pool[idx] || null;
}

/** 测试/诊断用：把内存状态摊平（不改任何东西）。 */
export function stickerLibrarySnapshot() {
  return {
    loaded,
    metaTrusted,
    items: customStickers(),
    kept: keptStickers(),
    urls: urls.size,
  };
}

/** 仅供测试：清掉内存缓存（不清磁盘、不清 meta）。 */
export function __resetForTests() {
  items = [];
  kept = [];
  loaded = false;
  loading = null;
  metaTrusted = false;
  releaseCustomUrls();
  listeners.clear();
}
