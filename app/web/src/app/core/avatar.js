/**
 * 「我」的头像。
 *
 * 三个动作：读出来显示、选一张存进去、清掉。字节存在原生侧
 * （`filesDir/avatars/user.png`），读回来是 base64，转成 blob URL 给 <img> 用 ——
 * 不能直接把 content:// 丢给图片标签，WebView 不认我们自己 fileprovider 的 uri。
 *
 * 为什么不走 localStorage 存 base64：头像 256 的 PNG 有几十 KB，localStorage
 * 一般只有 5 MB 且是同步写，聊天滚起来时写它会卡帧。原生侧存文件、这里只缓存 URL。
 */
import { call, isNative } from './native/bridge.js';
import { pickImage } from './media.js';

/** 当前头像的 blob URL。null = 还没读过；'' = 读过但没有头像。 */
let cachedUrl = null;
/** 正在读的那一次，避免同时进来两次各发一遍桥。 */
let inflight = null;
/** 换头像/清头像时通知界面重画。 */
const listeners = new Set();

export function onUserAvatarChange(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) {
    try {
      fn(cachedUrl || '');
    } catch (err) {
      console.warn('[avatar] 监听器出错', err);
    }
  }
}

function revoke() {
  if (cachedUrl) {
    try {
      URL.revokeObjectURL(cachedUrl);
    } catch {
      /* 已经 revoke 过了 */
    }
  }
}

function toBlobUrl(base64, mime) {
  try {
    const bin = atob(base64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([arr], { type: mime || 'image/png' }));
  } catch (err) {
    console.warn('[avatar] 拼 blob URL 失败', err);
    return '';
  }
}

/**
 * 拿当前头像的 URL，没有就返回 ''。
 *
 * 同步返回缓存值；第一次调用会先给 ''、后台把数据取回来，取回来之后
 * 通过 onUserAvatarChange 通知一声，界面自己重画。这样调用方（画每条消息）
 * 不用 await，聊天列表滚动时不会有异步等待。
 */
export function currentUserAvatar() {
  if (cachedUrl !== null) return cachedUrl;
  if (inflight) return '';
  inflight = (async () => {
    if (!isNative()) {
      cachedUrl = '';
      return;
    }
    try {
      const res = await call('EllenMedia', 'readUserAvatar', {});
      revoke();
      cachedUrl = res && res.base64 ? toBlobUrl(res.base64, res.mimeType) : '';
    } catch (err) {
      console.warn('[avatar] 读头像失败', err);
      cachedUrl = '';
    } finally {
      inflight = null;
    }
    emit();
  })();
  return '';
}

/** 强制重读一次（换头像、清头像、或从备份恢复之后）。 */
export async function refreshUserAvatar() {
  cachedUrl = null;
  inflight = null;
  currentUserAvatar();
  // 等这一趟真的落地，调用方 await 完就能拿到新 URL
  try {
    await inflight;
  } catch {
    /* 已经兜过 */
  }
  return cachedUrl || '';
}

/**
 * 选一张图当头像。用户取消选择返回 false，不是错误。
 *
 * 中间那一步 pickImage 用的是聊天发图同一条通道：选完会先压到 photos/ 里，
 * 我们再让原生从那张压过的图裁方形 —— 这样解码一次就够，不必重读原图。
 */
export async function pickUserAvatar() {
  if (!isNative()) return false;
  // withSrc:false —— 只要 uri，不需要把整张图再以 base64 传回 web 一遍
  // （头像最终是原生裁好的 256 PNG，中间那张原图没必要过桥两次）
  const picked = await pickImage({ maxSide: 512, maxBytes: 2 * 1024 * 1024, withSrc: false });
  if (!picked || !picked.picked || !picked.uri) return false;
  await call('EllenMedia', 'saveUserAvatar', { uri: picked.uri });
  await refreshUserAvatar();
  return true;
}

/** 清掉头像，回到没有头像的样子。 */
export async function clearUserAvatar() {
  if (!isNative()) return;
  await call('EllenMedia', 'clearUserAvatar', {});
  await refreshUserAvatar();
}
