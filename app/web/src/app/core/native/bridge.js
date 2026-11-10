// 原生插件调用层：复刻旧包那个通用派发器（minified 里叫 S2）的语义。
//
// 旧包用法形态（M0 从 chunk 里挖出来的原文）：
//   S2(t2, `startRecording`, { recordingId, fileId, maxDurationMs },
//      { signal, cancelMethod: `cancelRecording`, cleanup: true })
//
// 需要复刻的四条语义：
//   1. signal 中断 → 若给了 cancelMethod，就用同一个 requestId 调它；原调用自己会以 CANCELLED 收尾
//   2. cleanup:true → 失败路径必须再执行一次清理调用（cancel/discard 这类），清理又失败时
//      把原始错误与清理错误合成 AggregateError，别把原始错误吞掉
//   3. 长操作都带 requestId，它同时是取消句柄
//   4. 超时可配（native 侧已有 deadline 的不要在这里再套一层，避免两套超时打架）
import { Capacitor, registerPlugin } from '@capacitor/core';

const cache = new Map();

/** 取（并缓存）一个原生插件句柄。名字必须与 native 侧 @CapacitorPlugin(name=...) 完全一致。 */
export function plugin(name) {
  let p = cache.get(name);
  if (!p) {
    p = registerPlugin(name);
    cache.set(name, p);
  }
  return p;
}

export class NativeError extends Error {
  constructor(message, code, cause) {
    super(message);
    this.name = 'NativeError';
    this.code = code || 'NATIVE_ERROR';
    if (cause) this.cause = cause;
  }
}

export function codeOf(err) {
  if (!err) return 'NATIVE_ERROR';
  if (typeof err.code === 'string' && err.code) return err.code;
  // Capacitor 有时把 code 塞进 message 的尾部
  const m = /([A-Z][A-Z0-9_]{2,})$/.exec(String(err.message || ''));
  return m ? m[1] : 'NATIVE_ERROR';
}

function toNativeError(err) {
  if (err instanceof NativeError) return err;
  const message = (err && (err.message || err.errorMessage)) || String(err);
  return new NativeError(message, codeOf(err), err);
}

/**
 * 调一个原生方法。
 * @param {string} name 插件名
 * @param {string} method 方法名
 * @param {object} opts 传给 native 的参数（长操作请自行带 requestId）
 * @param {object} [ctl] { signal, cancelMethod, cleanup, cleanupOpts, timeoutMs }
 */
export async function call(name, method, opts = {}, ctl = {}) {
  const { signal, cancelMethod, cleanup = false, cleanupOpts = null, timeoutMs = 0 } = ctl;
  const target = plugin(name);
  const fn = target[method];
  if (typeof fn !== 'function') {
    throw new NativeError(`原生插件 ${name} 没有方法 ${method}`, 'PLUGIN_METHOD_MISSING');
  }

  const requestId = opts && typeof opts.requestId === 'string' ? opts.requestId : null;

  // 1. 中断转发
  let onAbort = null;
  if (signal && cancelMethod) {
    onAbort = () => {
      if (signal.aborted) {
        Promise.resolve(target[cancelMethod](requestId ? { requestId } : {})).catch(() => {});
      }
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  // 2. 可选超时（native 自己管 deadline 的别传 timeoutMs）
  let timer = null;
  let timedOut = false;

  try {
    const pending = Promise.resolve(fn.call(target, opts));
    let result;
    if (timeoutMs > 0) {
      result = await Promise.race([
        pending,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new NativeError(`${name}.${method} 超时未返回`, 'NATIVE_TIMEOUT'));
          }, timeoutMs);
        }),
      ]);
    } else {
      result = await pending;
    }
    return result;
  } catch (err) {
    const primary = timedOut ? err : toNativeError(err);

    // 3. 清理路径：必须执行；清理失败不覆盖原始错误，而是合成 AggregateError
    if (cleanup && cancelMethod) {
      try {
        const cleanArgs = cleanupOpts || (requestId ? { requestId } : {});
        await target[cancelMethod](cleanArgs);
      } catch (cleanErr) {
        throw new AggregateError(
          [primary, toNativeError(cleanErr)],
          `${name}.${method} 失败，且清理调用 ${cancelMethod} 也失败`
        );
      }
    }
    throw primary;
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort && signal) signal.removeEventListener('abort', onAbort);
  }
}

/** 监听原生事件。返回取消监听的函数。 */
export async function listen(name, event, handler) {
  const handle = await plugin(name).addListener(event, handler);
  return () => {
    try {
      handle.remove();
    } catch {
      /* 忽略：页面已销毁 */
    }
  };
}

/** 判断当前是否真的跑在原生壳里（浏览器里跑 vite dev 时为 false）。 */
export function isNative() {
  return Capacitor.isNativePlatform();
}

/** 造一个 requestId：`<前缀>:<uuid>`。老包的 requestId 校验规则是 [A-Za-z0-9][A-Za-z0-9._:-]{0,199}。 */
export function requestId(prefix = 'req') {
  const uuid =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : // 老 bug ⑥：某些 WebView 没有 randomUUID，必须有兜底
        'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
          const r = (Math.random() * 16) | 0;
          return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
        });
  return `${prefix}:${uuid}`;
}
