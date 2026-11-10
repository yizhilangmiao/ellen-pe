// 横屏几何检查：用 CDP 的 Emulation.setDeviceMetricsOverride 把 CSS 视口改成
// 900×420（manifest 锁了 portrait，设备真旋转不了），量完再复位。
// 用法：node cdp_landscape.js <port> <exprFile>
const port = process.argv[2] || '9334';
const exprFile = process.argv[3];
if (!exprFile) {
  console.error('用法: node cdp_landscape.js <port> <exprFile>');
  process.exit(2);
}
const fs = require('fs');

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('没有 page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
    });
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  });
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));

  const expr = fs.readFileSync(exprFile, 'utf8');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 900,
    height: 420,
    deviceScaleFactor: 3,
    mobile: true,
    screenOrientation: { type: 'landscapePrimary', angle: 90 },
  });
  await new Promise((r) => setTimeout(r, 600));
  const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, allowUnsafeEvalBlockedByCSP: true });
  console.log(JSON.stringify(res.result && res.result.value !== undefined ? res.result.value : res, null, 1));
  const shot = process.argv[4];
  if (shot) {
    const img = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(shot, Buffer.from(img.data, 'base64'));
    console.log('shot ' + shot + ' ' + Buffer.from(img.data, 'base64').length);
  }
  await send('Emulation.clearDeviceMetricsOverride');
  ws.close();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
