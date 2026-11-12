// 清场：按 head.id 前缀删（默认 memory:stress-*），连带删它的 revisions
// 只删前缀匹配的，真数据一条不动；删完打印前后计数，方便自证
(async (ARGS) => {
  const PREFIX = String(ARGS.prefix || 'memory:stress');
  // 一个场景可能同时造了三类（备份就是），所以吃数组
  const KINDS = ARGS.kinds && ARGS.kinds.length ? ARGS.kinds : [String(ARGS.kind || 'memory')];

  const db = await openDB();
  const before = {
    heads: await countStore(db, 'data-heads'),
    revisions: await countStore(db, 'data-revisions'),
    byKind: {},
  };
  for (const k of KINDS) before.byKind[k] = await countKind(db, k);

  // 只按前缀删，**不接受精确 id 清单**。
  // 2026-11-11 踩过：曾想用 headIds 清 journal.force() 顺手写的那一条，但 writeJournal
  // 是按「天」复用 head 的，返回的 headId 是**今天那篇真日记** —— 于是清场把真日记
  // 整条删了（head + 3 个 revision，leveldb 里已无残留，恢复不了）。
  // 现在 probe-journal.js 自己写完立刻回滚，clean.js 只碰自己造出来的种子。
  const targets = [];
  await new Promise((res, rej) => {
    const c = db.transaction('data-heads', 'readonly').objectStore('data-heads').openCursor();
    c.onsuccess = () => {
      const cur = c.result;
      if (!cur) return res();
      const h = cur.value;
      if (h && KINDS.includes(h.kind) && String(h.id).startsWith(PREFIX)) {
        targets.push({ id: h.id, revisions: Array.isArray(h.revisions) ? h.revisions : [] });
      }
      cur.continue();
    };
    c.onerror = () => rej(c.error);
  });

  const t0 = performance.now();
  for (let i = 0; i < targets.length; i += 500) {
    const slice = targets.slice(i, i + 500);
    const tx = db.transaction(['data-heads', 'data-revisions'], 'readwrite');
    const hs = tx.objectStore('data-heads');
    const rs = tx.objectStore('data-revisions');
    for (const x of slice) {
      hs.delete(x.id);
      for (const rid of x.revisions) rs.delete(rid);
    }
    await txDone(tx);
  }
  const ms = Math.round(performance.now() - t0);

  const after = {
    heads: await countStore(db, 'data-heads'),
    revisions: await countStore(db, 'data-revisions'),
    byKind: {},
  };
  for (const k of KINDS) after.byKind[k] = await countKind(db, k);
  db.close();

  // 索引缓存里还留着已删条目（invalidateRecall 只在写入方调），清完要刷新页面
  if (ARGS.reload) setTimeout(() => location.reload(), 120);

  return {
    prefix: PREFIX,
    kinds: KINDS,
    matched: targets.length,
    ms,
    before,
    after,
    reload: !!ARGS.reload,
  };
})
