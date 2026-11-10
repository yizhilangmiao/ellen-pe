// CDP 取值工具：连 WebView 的 devtools socket，在目标上下文里 eval 一段 JS 并回结果。
// 用法：
//   node cdp_eval.js list 9333
//   node cdp_eval.js eval 9333 _临时/expr.js [--target <substring>]
// 说明：Node 24 自带 fetch 与 WebSocket，不依赖 npm 包。
const fs = require('fs');

const mode = process.argv[2] || 'list';
const portOrUrl = process.argv[3];
const exprFile = process.argv[4];
const targetArg = process.argv.find((a) => a.startsWith('--target'));
const targetMatch = targetArg ? process.argv[process.argv.indexOf(targetArg) + 1] : null;

async function targets(base) {
  const res = await fetch(`http://127.0.0.1:${base}/json`);
  return res.json();
}

function pick(list) {
  if (targetMatch) {
    const hit = list.find((t) => t.url?.includes(targetMatch) || t.title?.includes(targetMatch));
    if (hit) return hit;
  }
  return list.find((t) => t.type === 'page') || list[0];
}

(async () => {
  if (/^\d+$/.test(portOrUrl)) {
    const list = await targets(portOrUrl);
    if (mode === 'list') {
      console.log(JSON.stringify(list.map((t) => ({ type: t.type, url: t.url, title: t.title, ws: t.webSocketDebuggerUrl })), null, 1));
      return;
    }
    const page = pick(list);
    if (!page) {
      console.error('[ERR] 没有可连的 target');
      process.exit(2);
    }
    console.error('[target]', page.type, page.url);
    await run(page.webSocketDebuggerUrl);
  } else {
    await run(portOrUrl);
  }
})();

async function run(wsUrl) {
  const expr = fs.readFileSync(exprFile, 'utf8');
  const ws = new WebSocket(wsUrl);
  const done = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression: expr, awaitPromise: true, returnByValue: true, allowUnsafeEvalBlockedByCSP: true },
      }));
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id !== 1) return;
      if (msg.error) return reject(new Error(JSON.stringify(msg.error)));
      const r = msg.result;
      if (r.exceptionDetails) {
        return reject(new Error('JS exception: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text)));
      }
      resolve(r.result?.value);
    });
    ws.addEventListener('error', (e) => reject(new Error('ws error: ' + (e.message || 'unknown'))));
    setTimeout(() => reject(new Error(`timeout ${Math.round(Number(process.env.CDP_TIMEOUT_MS || 25000) / 1000)}s`)), Number(process.env.CDP_TIMEOUT_MS || 25000));
  });
  try {
    const out = await done;
    console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 1));
  } catch (e) {
    console.error('[ERR]', e.message);
    process.exitCode = 1;
  } finally {
    try { ws.close(); } catch {}
  }
}
