// 意见反馈 / 写信给她（M7 · D12）。
//
// 旧包的反馈链是别人的：`EllenFeedbackHttpPlugin` 里写死
//   ENDPOINT = https://formsubmit.co/ajax/1520208183@qq.com
//   SOURCE   = https://formsubmit.co/el/xutine
// 也就是说信件的转发方是第三方、没有网络时整条链直接断，我们既看不到也管不了。
//
// 新壳改成「本机拼信 → 交给系统邮件 App」：不走任何第三方服务器，离线也能先把信写下来。
// 没有邮件 App 的机器（模拟器常见）退化成「复制到剪贴板」，不假装成功 —— 由 native
// `EllenFeedback.send` 返回 `via:'clipboard'` 告诉我们走了哪条路。
//
// native 侧：app\app\src\main\java\cn\ellen\companion2\plugin\EllenFeedbackPlugin.kt
import { call } from './native/bridge.js';
import { strings } from '../strings.zh.js';

/** 反馈分类：跟「她说的话」有关的、跟功能有关的、想说的。 */
export const KINDS = ['chat', 'app', 'words'];

export const MAX_BODY = 4000;

/** native 拿不到时（浏览器里跑 probe.html）用的兜底收件人。 */
export const FALLBACK_TO = '1520208183@qq.com';

let cachedInfo = null;

/** `{ to, subject, hasMailApp, version }`；失败只回兜底值，不抛。 */
export async function info() {
  if (cachedInfo) return cachedInfo;
  try {
    const res = await call('EllenFeedback', 'info');
    cachedInfo = {
      to: res.to || FALLBACK_TO,
      subject: res.subject || '',
      hasMailApp: !!res.hasMailApp,
      version: res.version || '',
    };
  } catch (err) {
    console.warn('[feedback] info 失败', err);
    cachedInfo = { to: FALLBACK_TO, subject: '', hasMailApp: false, version: '' };
  }
  return cachedInfo;
}

function kindLabel(kind) {
  const map = strings.feedback || {};
  if (kind === 'chat') return map.kindChat || '她说的话';
  if (kind === 'app') return map.kindApp || '功能问题';
  return map.kindWords || '想说的话';
}

/**
 * 拼一封信。
 *
 * 带上版本号和机型：老大自己收信，没有这些每次都要回一句「你装的是哪一版」。
 */
export async function compose({ kind = 'app', text = '' } = {}) {
  const meta = await info();
  const body = String(text || '').trim().slice(0, MAX_BODY);
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent || '';
  // WebView 的 UA 里带 Android 版本；够定位问题，不额外申请权限去读设备信息。
  const android = (ua.match(/Android\s+([\d.]+)/) || [])[1] || '';
  const lines = [
    body,
    '',
    '——',
    `版本：${meta.version || '未知'}`,
    `分类：${kindLabel(kind)}`,
    android ? `Android：${android}` : '',
    `时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
  ].filter((line) => line !== '');
  const subject = meta.subject
    ? `${meta.subject} · ${kindLabel(kind)}`
    : `艾莲手机版 · ${kindLabel(kind)}`;
  return { to: meta.to, subject, body: lines.join('\n') };
}

/**
 * 发出去。
 *
 * 返回 `{ ok, via }`：`mail` = 打开了邮件 App（信在草稿里，用户自己点发送）；
 * `clipboard` = 没有邮件 App，整封信已复制。
 * 抛错只有一种情况：既没有邮件 App 又写不进剪贴板 —— 这时上层要提示用户手动抄。
 */
export async function send({ kind = 'app', text = '' } = {}) {
  if (!String(text || '').trim()) {
    const err = new Error('信里还没有内容。');
    err.code = 'FEEDBACK_EMPTY';
    throw err;
  }
  const letter = await compose({ kind, text });
  const res = await call('EllenFeedback', 'send', { subject: letter.subject, body: letter.body });
  return { ok: !!res.ok, via: res.via || 'mail', letter };
}

/** 备用：只复制，不开邮件 App。 */
export async function copy(text) {
  const res = await call('EllenFeedback', 'copy', { text: String(text || '') });
  return !!res.copied;
}
