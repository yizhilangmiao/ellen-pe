// 用 CDP 在页面里点击元素：node cdp_click.js <port> <selector>
// selector 支持三种写法：
//   1) 普通 CSS 选择器   button.el-segment[data-memory-page="memories"]
//   2) text:<文字>       text:回忆        （文本完全匹配，向上找可点祖先）
//   3) xpath:<表达式>    xpath://button[@aria-label="设置"]
const port = process.argv[2];
const selector = process.argv[3];

const buildExpr = (sel) => {
  if (sel.startsWith('text:')) {
    const want = JSON.stringify(sel.slice(5));
    return `(() => {
      const all = [...document.querySelectorAll('*')].filter((e) => {
        if (e.children.length > 2) return false;
        return (e.textContent || '').trim() === ${want};
      });
      const el = all.find((e) => e.getBoundingClientRect().width > 0) || all[0];
      if (!el) return 'NOT_FOUND';
      let node = el;
      for (let i = 0; i < 6 && node; i++) {
        const tag = node.tagName;
        if (tag === 'BUTTON' || node.getAttribute('role') === 'button' || /(^|\\s)el-(segment|round|brand|primary|secondary|entry|hint-action)(\\s|$)/.test(node.className || '')) break;
        node = node.parentElement;
      }
      const t = node || el;
      t.scrollIntoView({ block: 'center' });
      t.click();
      return 'CLICKED(text) ' + t.tagName + '.' + (t.className || '').toString().slice(0, 40);
    })()`;
  }
  if (sel.startsWith('xpath:')) {
    const xp = JSON.stringify(sel.slice(6));
    return `(() => {
      const r = document.evaluate(${xp}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      const el = r.singleNodeValue;
      if (!el) return 'NOT_FOUND';
      el.scrollIntoView({ block: 'center' });
      el.click();
      return 'CLICKED(xpath) ' + el.tagName + '.' + (el.className || '').toString().slice(0, 40);
    })()`;
  }
  return `(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return 'NOT_FOUND';
    el.scrollIntoView({ block: 'center' });
    el.click();
    return 'CLICKED ' + (el.className || '') + ' | ' + (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30);
  })()`;
};

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const expr = buildExpr(selector);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 20000);
    ws.onopen = () => ws.send(JSON.stringify({
      id: 1, method: 'Runtime.evaluate',
      params: { expression: expr, returnByValue: true, awaitPromise: true },
    }));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== 1) return;
      clearTimeout(timer);
      const r = msg.result && msg.result.result;
      console.log(r && r.value !== undefined ? r.value : JSON.stringify(msg.result));
      ws.close();
      resolve();
    };
    ws.onerror = (e) => { clearTimeout(timer); reject(e); };
  });
}

main().catch((e) => { console.error(e && e.message ? e.message : String(e)); process.exit(1); });
