// 音量台的数据层（契约 §2：EllenVolume.get / EllenVolume.set）。
//
// 为什么单独一个模块，而不是写在 chat.js 里：
//   1) 音量是「设备状态」，不是聊天页的私有状态 —— 设置页、相处页以后也要读它；
//   2) 拖滑杆时 input 事件是 60Hz 级别的，每次都跨进程调原生桥会把桥打爆，
//      节流必须和数据一起收在同一个地方，否则谁调谁都要重写一遍节流；
//   3) 读失败要有统一回落值（60），否则每处调用各写一个默认值，界面上就会互相打架。
import { call, isNative, requestId } from './native/bridge.js';

/** 读不到音量时的回落值。取 60 是因为默认媒体音量大约在中间偏上，用户不会觉得「被调小了」。 */
export const DEFAULT_VOLUME = 60;

/** 写节流窗口。120ms 约等于 8Hz：手指快速拖动时既跟得上，又只发 1/8 的跨进程调用。 */
const WRITE_THROTTLE_MS = 120;

/** 本地镜像。面板先按它画，读到原生的真实值再覆盖（避免打开面板时闪一下 0%）。 */
let cache = { volume: DEFAULT_VOLUME, max: 100, muted: false, supported: false };

/** 待写值（尾包）：节流窗口结束时必须把这个值落地，否则「拖到 30，实际还是 45」。 */
let pending = null;
let timer = 0;

/** 镜像变化的订阅者。原生 set 会回一个「档位换算后的真实百分比」，
 *  界面上的滑杆和数字必须按它回填，否则显示的 37% 和手机的 40% 会一直对不上。 */
const listeners = new Set();

function emit() {
  if (!listeners.size) return;
  const snap = { ...cache };
  listeners.forEach((fn) => {
    try {
      fn(snap);
    } catch (err) {
      /* 订阅者自己的异常不该打断其他订阅者 */
    }
  });
}

/**
 * 订阅镜像变化（原生回填值也走这里）。
 * @param {(snap:{volume:number, max:number, muted:boolean, supported:boolean}) => void} fn
 * @returns {() => void} 退订
 */
export function onVolumeChange(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 把任意输入收拾成 0-100 的整数。原生只吃整数，传小数会在 Kotlin 侧被截断成意外值。 */
function clampVolume(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return DEFAULT_VOLUME;
  return Math.max(0, Math.min(100, n));
}

/** 这台手机能不能改音量。浏览器里（vite dev / 验收）一律 false，UI 据此灰掉滑杆。 */
export function volumeSupported() {
  return isNative();
}

/**
 * 读当前媒体音量。
 * @returns {Promise<{volume:number, max:number, muted:boolean, supported:boolean}>}
 *          读失败（没有插件 / 老包 / 浏览器）回落 {volume: 60, supported: false}，不抛错 ——
 *          音量面板不该因为一台手机不支持就整个打不开。
 */
export async function readVolume() {
  if (!volumeSupported()) {
    return { ...cache, volume: DEFAULT_VOLUME, muted: false, supported: false };
  }
  try {
    const res = await call('EllenVolume', 'get', { requestId: requestId('vol') });
    const volume = clampVolume(res && res.volume);
    const max = Number(res && res.max) > 0 ? Number(res.max) : 100;
    cache = { volume, max, muted: volume === 0, supported: true };
    emit();
    return { ...cache };
  } catch (err) {
    // 插件还没编进包（T6 未合）时这里会拿到 PLUGIN_METHOD_MISSING：
    // 记 supported:false，界面给一句人话，而不是让人对着一个拖不动的滑杆猜。
    cache = { ...cache, volume: DEFAULT_VOLUME, muted: false, supported: false };
    emit();
    return { ...cache };
  }
}

/** 真正发一次 set。失败只记日志，不往界面抛：拖滑杆时抛错会刷一屏。 */
async function push(value) {
  try {
    const res = await call('EllenVolume', 'set', { requestId: requestId('vol'), volume: value });
    const applied = Number(res && res.volume);
    if (Number.isFinite(applied)) {
      const v = clampVolume(applied);
      cache = { ...cache, volume: v, muted: v === 0 };
      // 原生按档位取整过：把真实值回填给界面，否则显示值和手机实际值永远差一格
      emit();
      return v;
    }
    return value;
  } catch (err) {
    console.warn('[volume] 设置音量失败', err);
    return null;
  }
}

function flush() {
  timer = 0;
  if (pending === null) return;
  const value = pending;
  pending = null;
  push(value);
}

/**
 * 写媒体音量（节流 120ms，尾包必达）。
 * 同步返回「界面应该显示的值」——滑杆据此即时跟手，不必等原生回来。
 * @param {number} v 0-100
 * @returns {number} 收拾后的值
 */
export function writeVolume(v) {
  const target = clampVolume(v);
  cache = { ...cache, volume: target, muted: target === 0 };
  if (!volumeSupported()) return target;
  pending = target;
  if (!timer) timer = setTimeout(flush, WRITE_THROTTLE_MS);
  return target;
}

/**
 * 立刻把尾包写下去。面板关闭 / 视图销毁时调，
 * 否则最后一次拖动可能落在定时器里被丢掉（人走了，音量还停在上一格）。
 * @returns {Promise<number|null>} 实际落地的值；没有待写值时为 null
 */
export async function flushVolume() {
  if (timer) {
    clearTimeout(timer);
    timer = 0;
  }
  if (pending === null) return null;
  const value = pending;
  pending = null;
  return push(value);
}

/** 只看镜像，不打扰原生（渲染时用，别在每帧里 await 一次 get）。 */
export function cachedVolume() {
  return { ...cache };
}

/** 把镜像改回未知态（换设备 / 用户改完系统音量回来时调）。 */
export function resetVolume() {
  cache = { ...cache, supported: false };
  pending = null;
  if (timer) {
    clearTimeout(timer);
    timer = 0;
  }
}

// —— 契约 §2 里的名字：getVolume / setVolume / step ——
// 与上面 read/write 是同一份实现，两套名字都留着，谁先写好的调用都不用改。

/** @returns {Promise<{volume:number, max:number, muted:boolean, supported:boolean}>} 同 readVolume */
export function getVolume() {
  return readVolume();
}

/** @param {number} n 0-100 @returns {number} 同 writeVolume */
export function setVolume(n) {
  return writeVolume(n);
}

/**
 * 在当前值上加减（音量键那种一步 10）。
 * @param {number} delta 正负整数
 * @returns {number} 新的显示值
 */
export function step(delta) {
  return writeVolume(cache.volume + (Number(delta) || 0));
}
