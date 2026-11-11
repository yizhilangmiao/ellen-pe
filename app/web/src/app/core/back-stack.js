// 返回栈：所有「返回」的来源都汇到这里，只留一个 owner。
//
// 为什么要它：批 3 之后抽屉自己压了一条 history 并监听 popstate，系统返回键如果再走
// history，一次会按掉两层（抽屉 + 页面）。所以把「谁该吃掉这一下」收成一条按优先级排序
// 的链，抽屉不再碰 history。
//
// 优先级（数字大的先处理，第一个返回 true 的吃掉）：
//   60 录音中（取消录音，不导航）
//   50 浮层（记忆编辑器等模态）
//   40 顶栏「⋯」菜单
//   30 抽屉（回忆 / 相处 / 设置）
//   20 页面栈里 push 进去的全屏页
//   10 非聊天页 → 回聊天
//    0 兜底（由 main.js 注册双按退出）
//
// 用法：
//   const off = registerBack(() => { ...; return true; }, { priority: 40 });
//   off();  // 关掉时一定要反注册，否则处理链会越堆越长
import { plugin } from './native/bridge.js';

const handlers = [];
let installed = false;
let seq = 0;

/**
 * 注册一个返回处理器。
 * @param {(ctx: {from: 'system'|'ui'}) => boolean|void} fn 返回 true = 这一下被吃掉
 * @param {{priority?: number, name?: string}} [opts]
 * @returns {() => void} 反注册
 */
export function registerBack(fn, { priority = 0, name = '' } = {}) {
  const item = { fn, priority, name, id: ++seq };
  handlers.push(item);
  return function unregister() {
    const i = handlers.indexOf(item);
    if (i >= 0) handlers.splice(i, 1);
  };
}

/** 从高到低问一遍；有人返回 true 就停。 */
export function requestBack(ctx = { from: 'ui' }) {
  const sorted = [...handlers].sort((a, b) => b.priority - a.priority);
  for (const item of sorted) {
    let handled = false;
    try {
      handled = item.fn(ctx) === true;
    } catch (err) {
      console.error(`[back] 处理器 ${item.name || item.id} 出错`, err);
    }
    if (handled) return true;
  }
  return false;
}

/** 按优先级看谁能处理（诊断用，不执行）。 */
export function backChain() {
  return [...handlers]
    .sort((a, b) => b.priority - a.priority)
    .map((h) => ({ name: h.name, priority: h.priority }));
}

/**
 * 装系统返回键监听。没处理掉就交给 onUnhandled（main.js 里做「再按一次退出」）。
 * @returns {boolean} 是否装上了（不在原生壳里返回 false）
 */
export function installAndroidBack(onUnhandled) {
  if (installed) return true;
  let App = null;
  try {
    App = plugin('App');
  } catch {
    App = null;
  }
  if (!App || typeof App.addListener !== 'function') return false;
  App.addListener('backButton', () => {
    if (requestBack({ from: 'system' })) return;
    if (typeof onUnhandled === 'function') onUnhandled();
  });
  installed = true;
  return true;
}

/**
 * 「退出」= 回桌面，不是杀进程。
 * 用 minimizeApp 而不是 exitApp：进程要留着发主动消息、收后台提醒，
 * exitApp 会把前台服务和闹钟一起带走。
 * @returns {Promise<boolean>} 成功与否
 */
export async function minimizeApp() {
  try {
    const App = plugin('App');
    if (!App || typeof App.minimizeApp !== 'function') return false;
    await App.minimizeApp();
    return true;
  } catch (err) {
    console.warn('[back] minimizeApp 失败', err);
    return false;
  }
}
