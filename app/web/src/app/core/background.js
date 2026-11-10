import { registerPlugin } from '@capacitor/core';

/**
 * 前台保活 —— 让「话还没说完就切走」不被打断。
 *
 * 旧包 EllenBackground 的正面用法：Activity 一进后台，系统随时可以回收 WebView 进程，
 * 流式回复会断在半截。新壳沿用同一条思路，但通知只是低压常驻（无声、不可划掉），
 * 真正保命的是 native 那边的 foregroundServiceType=dataSync。
 *
 * 这边只做三件事：开始说 → keepAlive(true)，说完 → keepAlive(false)，收件箱取一条。
 * 详细实现见 app/app/src/main/java/cn/ellen/companion2/background/EllenBackgroundService.kt
 */
const EllenBackground = registerPlugin('EllenBackground');

/** 一次进程一个 sessionId：native 用它判断「这条后台任务是这一轮的还是上一轮的」。 */
const SESSION_ID = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

let threadId = '';
let active = false;

function safe(fn, fallback = null) {
  try {
    return fn();
  } catch (err) {
    console.warn('[background]', err);
    return fallback;
  }
}

export function sessionId() {
  return SESSION_ID;
}

export function setThread(id) {
  threadId = id || '';
}

/**
 * @param {boolean} on  true = 有活在跑（保活）；false = 活干完了（撤服务）
 * @param {{replyActive?:boolean, mediaActive?:boolean, organizationActive?:boolean,
 *          organizationTotal?:number, organizationDone?:number, paused?:boolean}} [extra]
 */
export async function keepAlive(on, extra = {}) {
  if (active === !!on && !Object.keys(extra).length) return null;
  active = !!on;
  return safe(
    () =>
      EllenBackground.update({
        sessionId: SESSION_ID,
        threadId,
        replyActive: extra.replyActive ?? false,
        mediaActive: extra.mediaActive ?? false,
        paused: extra.paused ?? false,
        organizationActive: extra.organizationActive ?? false,
        organizationTotal: extra.organizationTotal ?? 0,
        organizationDone: extra.organizationDone ?? 0,
      }),
    null
  );
}

/** 一轮回复开始/结束的便捷封装：不会抛，失败就降级成「不保活」。 */
export async function withKeepAlive(task) {
  await keepAlive(true, { replyActive: true });
  try {
    return await task();
  } finally {
    await keepAlive(false);
  }
}

export function state() {
  return safe(() => EllenBackground.state(), null);
}

export function stop() {
  active = false;
  return safe(() => EllenBackground.stop(), null);
}

export function available() {
  return !!safe(() => EllenBackground && typeof EllenBackground.update === 'function', false);
}

/** 后台到齐的聊天回复（native 侧 messageArrived 落的）。 */
export async function takeChatReply() {
  const found = await safe(() => EllenBackground.consumeMessageOpen(), null);
  if (found && found.type === 'chat' && found.text) return found;
  return null;
}
