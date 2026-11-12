/**
 * cdp.mjs — 连 Android WebView 的 DevTools 端口
 *
 * 与 工具\脚本\cdp.mjs（连 Electron，9336）不是一回事：
 * 手机版是 WebView，socket 名形如 @webview_devtools_remote_<pid>，
 * 必须先 adb forward 成 TCP 端口才能连。命令见 _压测\README.md 第一节。
 */
const DEFAULT_PORT = 9222;
const DEFAULT_TIMEOUT = 120000;

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.json();
}

/**
 * @param {number} port 本地已 forward 的端口
 * @returns {Promise<{target:object, evaluate:Function, shot:Function, close:Function}>}
 */
export async function connect(port = DEFAULT_PORT) {
  let list;
  try {
    list = await fetchJson(`http://127.0.0.1:${port}/json/list`);
  } catch (e) {
    throw new Error(
      `连不上 127.0.0.1:${port}（${e.message}）\n` +
        `先转发端口，见 _压测\\README.md 第一节：\n` +
        `  adb -s 127.0.0.1:16448 shell "cat /proc/net/unix | grep devtools"\n` +
        `  adb -s 127.0.0.1:16448 forward tcp:${port} localabstract:webview_devtools_remote_<pid>`
    );
  }
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error(`127.0.0.1:${port} 上没有 page target —— 艾莲没在前台，或冷启动还没画完`);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('devtools ws 握手失败（端口被别的会话占了？）'));
  });

  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (m.id && pending.has(m.id)) {
      const fn = pending.get(m.id);
      pending.delete(m.id);
      fn(m);
    }
  };
  ws.onclose = () => {
    for (const fn of pending.values()) fn({ error: { message: 'devtools ws 断了' } });
    pending.clear();
  };

  const send = (method, params, timeoutMs = DEFAULT_TIMEOUT) =>
    new Promise((res, rej) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        rej(new Error(`${method} 超时 ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, (m) => {
        clearTimeout(timer);
        if (m.error) rej(new Error(`${method} 失败: ${JSON.stringify(m.error)}`));
        else res(m.result);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });

  return {
    target: { title: page.title, url: page.url },

    /** 在页面里执行表达式；页面抛错时抛出真实错误描述，不是「undefined」 */
    async evaluate(expr, { timeoutMs = DEFAULT_TIMEOUT } = {}) {
      const r = await send(
        'Runtime.evaluate',
        { expression: expr, awaitPromise: true, returnByValue: true },
        timeoutMs
      );
      if (r.exceptionDetails) {
        const d = r.exceptionDetails;
        const desc = (d.exception && d.exception.description) || d.text || JSON.stringify(d);
        throw new Error('页面内异常: ' + String(desc).split('\n')[0]);
      }
      return r.result.value;
    },

    async shot(file) {
      const r = await send('Page.captureScreenshot', { format: 'png' }, 30000);
      const { writeFileSync, statSync } = await import('node:fs');
      writeFileSync(file, Buffer.from(r.data, 'base64'));
      return statSync(file).size;
    },

    /**
     * 重载页面并等它回来。
     * 为什么需要：召回索引是模块级缓存（5 分钟 TTL），清场/造数都绕过写入方，
     * 缓存里还留着旧条目。重载是唯一可靠的清缓存手段。
     */
    async reloadPage({ timeoutMs = 60000 } = {}) {
      await send('Page.enable', {});
      await send('Page.reload', { ignoreCache: false }, 15000);
      const t0 = Date.now();
      let ready = false;
      while (Date.now() - t0 < timeoutMs) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          const st = await this.evaluate(
            `(() => ({ ready: document.readyState, app: !!(window.__ellen && window.__ellen.recall) }))()`,
            { timeoutMs: 5000 }
          );
          if (st && st.ready === 'complete' && st.app) {
            ready = true;
            break;
          }
        } catch {
          /* execution context 正在换，正常 */
        }
      }
      if (!ready) throw new Error(`页面重载后 ${timeoutMs}ms 内没回来`);
      await new Promise((r) => setTimeout(r, 800)); // 首屏渲染收尾
      return Date.now() - t0;
    },

    close() {
      try {
        ws.close();
      } catch {
        /* 已断 */
      }
    },
  };
}
