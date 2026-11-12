// 应用内更新（EllenUpdates 的 web 门面）
//
// 为什么要有：旧包的更新链是「查 COS 上的 latest.json → 下载 → 校验 sha256 → 拉起系统安装」，
// 但地址写死在别人的桶里。新壳把地址变成可配置（native 的 configure），默认空 = 不联网、不报错。
//
// 契约（5 + 1 方法，事件 updateState）见 contract\native-plugins.json 的 EllenUpdates：
//   state / check / download / install / cancel (+ configure，新壳新增)
//   phase: idle | checking | current | available | downloading | ready | verifying |
//          installing | permission | unpublished | cancelled | error
import { call } from './native/bridge.js';

const KEY = 'ellen.updates.v1';

function readLocal() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (_) {
    return {};
  }
}

function writeLocal(patch) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...readLocal(), ...patch }));
  } catch (_) {
    // 存不下不影响功能
  }
}

// 自建更新站（2026-11-13 老大定：不用 OSS、没域名没证书，走服务器固定公网 IP）
// 换服务器或换 IP 时只需要改这一行 + network_security_config.xml 的明文白名单。
const DEFAULT_MANIFEST = 'http://120.27.162.122:8080/latest.json';

/** 设过就用设过的（设成空 = 主动关掉更新检查），没设过用默认地址 */
export function manifestUrl() {
  const local = readLocal();
  if (typeof local.manifest === 'string') return local.manifest;
  return DEFAULT_MANIFEST;
}

/**
 * 启动时把清单地址同步给 native。
 * native 侧 prefs 是空的（重装 / 清数据后）时会一直报「还没有配更新地址」，
 * 装了新包却点不动更新，看起来像功能坏了。
 */
export async function ensureConfigured() {
  const url = manifestUrl();
  if (!url) return null;
  if (!(await available())) return null;
  return configure(url);
}

export async function available() {
  return !!(window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.EllenUpdates);
}

export async function state() {
  if (!(await available())) return { supported: false, phase: 'idle', current: {} };
  try {
    return await call('EllenUpdates', 'state', {});
  } catch (err) {
    return { supported: false, phase: 'error', message: String((err && err.message) || err), current: {} };
  }
}

/** 配更新清单地址；传空字符串 = 关掉更新检查 */
export async function configure(manifest) {
  writeLocal({ manifest: manifest || '' });
  if (!(await available())) return null;
  return call('EllenUpdates', 'configure', { manifest: manifest || '' });
}

export async function check() {
  return call('EllenUpdates', 'check', {});
}

export async function download() {
  return call('EllenUpdates', 'download', {});
}

export async function install() {
  return call('EllenUpdates', 'install', {});
}

export async function cancel() {
  return call('EllenUpdates', 'cancel', {});
}

/** 订阅更新状态（native 的 updateState 事件 → cb(state)） */
export async function onUpdate(cb) {
  if (!(await available())) return () => {};
  const handle = await window.Capacitor.Plugins.EllenUpdates.addListener('updateState', (data) => cb(data));
  return () => {
    try {
      handle.remove();
    } catch (_) {
      // 卸载失败无所谓
    }
  };
}

/** 「12%。3.2 MB / 27.1 MB」这种进度文案；没总长就只写已下载 */
export function progressText(st) {
  const got = Number((st && st.received) || 0);
  const all = Number((st && st.total) || 0);
  if (!got) return '';
  const mb = (n) => (n / 1048576).toFixed(1);
  if (!all) return `${mb(got)} MB`;
  const pct = Math.min(100, Math.round((got / all) * 100));
  return `${pct}% · ${mb(got)} / ${mb(all)} MB`;
}
