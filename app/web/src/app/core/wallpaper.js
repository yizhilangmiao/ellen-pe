// 聊天背景：选一张图当聊天页的壁纸（排期第 6 项）。
//
// 三层分工：
//   1) 原生 EllenMedia.saveWallpaper —— 长边压到 1920、编 JPEG、落 filesDir/wallpapers/wall.jpg；
//   2) 这里 —— 记住「铺法 / 模糊」这两个纯显示参数（localStorage），
//      把图读回来变 blob URL，写到 .ellen-app 的 CSS 变量上；
//   3) zz-wall.css 的 .has-wall 分支 —— 真正画。
//
// 为什么参数存 localStorage 而图存文件系统：参数几十字节，跟着应用数据走最省事；
// 图可能几百 KB，塞 localStorage 会让整包导出变得又慢又容易超配额。
//
// 为什么图要过 base64 再变 blob：WebView 不认我们 fileprovider 的 content://
// （头像那边同一条限制），唯一的回传通道是插件的 base64 字符串。
import { call, isNative } from './native/bridge.js';
import { pickImage } from './media.js';

/** 设置项存储键。只存 {fit, blur}，不存图。 */
export const WALL_KEY = 'ellen.wallpaper.v1';

/** 铺法：cover 铺满（可能裁边） / contain 完整显示（可能留边）。 */
export const WALL_FITS = ['cover', 'contain'];

/** 模糊三档（CSS px）。不做滑杆：手机上拉滑杆要么拉到 0 要么拉到 30，三档更好点。 */
export const WALL_BLURS = [0, 12, 26];

const DEFAULT_META = { fit: 'cover', blur: 0 };

/** 当前 blob URL。null = 还没读过；'' = 读过，没有背景。 */
let cachedUrl = null;

/** 正在读图时的 promise，防并发重复过桥。 */
let inflight = null;

const listeners = new Set();

function emit() {
  listeners.forEach((fn) => {
    try {
      fn();
    } catch (err) {
      console.warn('[wallpaper] listener failed', err);
    }
  });
}

function base64ToBlobUrl(base64, mime) {
  const bin = atob(String(base64 || ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime || 'image/jpeg' }));
}

function readMeta() {
  try {
    const raw = localStorage.getItem(WALL_KEY);
    if (!raw) return { ...DEFAULT_META };
    const parsed = JSON.parse(raw);
    const fit = WALL_FITS.includes(parsed && parsed.fit) ? parsed.fit : DEFAULT_META.fit;
    const blur = WALL_BLURS.includes(Number(parsed && parsed.blur))
      ? Number(parsed.blur)
      : DEFAULT_META.blur;
    return { fit, blur };
  } catch (err) {
    // 存坏了（手改过 / 别的版本写歪）就当没设过，不要让聊天页起不来
    return { ...DEFAULT_META };
  }
}

/** 读当前的铺法 / 模糊。 */
export function readWallpaperMeta() {
  return readMeta();
}

/** 改铺法或模糊，只接受白名单里的值。 */
export function writeWallpaperMeta(patch = {}) {
  const next = { ...readMeta() };
  if (patch.fit !== undefined) {
    if (!WALL_FITS.includes(patch.fit)) throw new Error(`铺法不认识：${patch.fit}`);
    next.fit = patch.fit;
  }
  if (patch.blur !== undefined) {
    const blur = Number(patch.blur);
    if (!WALL_BLURS.includes(blur)) throw new Error(`模糊档位不认识：${patch.blur}`);
    next.blur = blur;
  }
  try {
    localStorage.setItem(WALL_KEY, JSON.stringify(next));
  } catch (err) {
    // 隐私模式 / 配额满：参数这次只在内存里生效，下次打开回默认
    console.warn('[wallpaper] 存不下设置', err);
  }
  emit();
  return next;
}

/** 同步拿当前背景 URL（'' = 没有）。首次调用会在后台去读，读完 emit。 */
export function currentWallpaper() {
  if (cachedUrl !== null) return cachedUrl;
  if (!isNative()) {
    cachedUrl = '';
    return cachedUrl;
  }
  if (inflight) return '';
  inflight = call('EllenMedia', 'readWallpaper', {}, { timeoutMs: 15000 })
    .then((res) => {
      if (res && res.base64) {
        if (cachedUrl) URL.revokeObjectURL(cachedUrl);
        cachedUrl = base64ToBlobUrl(res.base64, res.mimeType || 'image/jpeg');
      } else {
        cachedUrl = '';
      }
      return cachedUrl;
    })
    .catch((err) => {
      console.warn('[wallpaper] 读背景失败', err);
      cachedUrl = '';
      return '';
    })
    .finally(() => {
      inflight = null;
      emit();
    });
  return '';
}

/** 强制重读（换过图、或从别处回来要知道最新状态）。 */
export async function refreshWallpaper() {
  if (cachedUrl) URL.revokeObjectURL(cachedUrl);
  cachedUrl = null;
  inflight = null;
  currentWallpaper();
  await inflight;
  return cachedUrl;
}

/**
 * 把当前背景刷到页面上：有图就设 CSS 变量 + 挂 .has-wall，
 * 没图就把类摘掉（退回 zzz 那套时段静态壁纸）。
 * @param {HTMLElement} [root] 默认 .ellen-app
 */
export function applyWallpaper(root) {
  const host = root || document.querySelector('.ellen-app');
  if (!host) return '';
  const url = currentWallpaper();
  if (!url) {
    // 图还没读回来（首次）或确实没有：先把上次的痕迹清掉，别让残留变量骗过 CSS
    if (host.classList.contains('has-wall')) {
      host.classList.remove('has-wall');
      host.style.removeProperty('--wall-image');
    }
    return '';
  }
  const meta = readMeta();
  host.style.setProperty('--wall-image', `url("${url}")`);
  host.style.setProperty('--wall-fit', meta.fit);
  host.style.setProperty('--wall-blur', `${meta.blur}px`);
  host.classList.add('has-wall');
  return url;
}

/** 订阅变化，返回退订函数。 */
export function onWallpaperChange(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 选一张图当背景。返回 {ok, reason?}，不抛。 */
export async function pickWallpaper() {
  if (!isNative()) return { ok: false, reason: 'NOT_NATIVE' };
  // 背景比聊天气泡里的图能吃大一些：4 MB。原生压到长边 1920 之后很少还会超。
  const picked = await pickImage({ maxSide: 1920, maxBytes: 4194304, withSrc: false });
  if (!picked || !picked.picked) return { ok: false, reason: (picked && picked.reason) || 'CANCELLED' };
  try {
    await call('EllenMedia', 'saveWallpaper', { uri: picked.uri }, { timeoutMs: 30000 });
  } catch (err) {
    console.warn('[wallpaper] 存背景失败', err);
    return { ok: false, reason: String((err && err.code) || 'WALL_SAVE_FAILED') };
  }
  await refreshWallpaper();
  return { ok: true };
}

/** 清掉背景，退回静态壁纸。 */
export async function clearWallpaper(root) {
  try {
    if (isNative()) await call('EllenMedia', 'clearWallpaper', {}, { timeoutMs: 10000 });
  } catch (err) {
    console.warn('[wallpaper] 清背景失败', err);
  }
  if (cachedUrl) URL.revokeObjectURL(cachedUrl);
  cachedUrl = '';
  applyWallpaper(root);
  emit();
  return { ok: true };
}
