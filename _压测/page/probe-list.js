// 测记忆列表首屏：卡数 / DOM 节点 / 滚动高度 / 耗时，以及「再多看几条」的翻页耗时
// 口径：domNodes = 整页元素数（不只是列表内），与 M16 的 60,182 一致
(async (ARGS) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nav = [...document.querySelectorAll('.el-nav-item')];
  const mem = nav.find((x) => (x.dataset.tab || x.dataset.name) === 'memory');
  if (!mem) return { error: '没找到「她的过去」导航项，页面结构可能变了' };

  mem.click();
  await sleep(600);

  const tabs = [...document.querySelectorAll('.el-memory-tabs .el-segment')];
  const past = tabs.find((b) => b.dataset.memoryTab === 'past');
  if (past) past.click();

  // 等首屏卡片出现（最多 6 秒）
  let cards = 0;
  const t0 = performance.now();
  for (let i = 0; i < 60; i += 1) {
    await sleep(100);
    cards = document.querySelectorAll('.el-memory-card').length;
    if (cards > 0) break;
  }
  const firstMs = Math.round(performance.now() - t0);

  const domNodes = document.getElementsByTagName('*').length;
  let maxScroll = 0;
  for (const el of document.querySelectorAll('*')) {
    if (el.scrollHeight > maxScroll) maxScroll = el.scrollHeight;
  }

  const out = { cards, domNodes, scrollHeight: maxScroll, firstMs };

  const more = document.querySelector('.el-journal-more');
  if (more) {
    const before = document.querySelectorAll('.el-memory-card').length;
    const t1 = performance.now();
    more.click();
    await sleep(80);
    out.paging = {
      before,
      after: document.querySelectorAll('.el-memory-card').length,
      ms: Math.round(performance.now() - t1),
      label: String(more.textContent || '').trim(),
    };
  } else {
    out.paging = null;
  }
  return out;
})
