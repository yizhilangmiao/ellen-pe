// 清孤儿 revision：head 已不存在、也没有任何 head 引用它的 revision
//
// 为什么会有孤儿：`_临时\` 里那批压测清场脚本（m8-*.js）只删了 data-heads，
// 没删 data-revisions。2026-11-11 实测库里 107 个 heads 配 20,874 个 revisions，
// 其中 20,710 条是孤儿（message 20,000 / journal 704 / memory 6）。
//
// 默认 dry-run，只统计不删。要真删必须传 ARGS.apply = true。
(async (ARGS) => {
  const APPLY = ARGS.apply === true;
  const db = await openDB();

  const all = (store) =>
    new Promise((res, rej) => {
      const rq = db.transaction(store, 'readonly').objectStore(store).getAll();
      rq.onsuccess = () => res(rq.result || []);
      rq.onerror = () => rej(rq.error);
    });

  const headRows = await all('data-heads');
  const revs = await all('data-revisions');

  const headIds = new Set(headRows.map((h) => String(h.id)));
  const referenced = new Set();
  for (const h of headRows) for (const r of h.revisions || []) referenced.add(String(r));

  const orphans = revs.filter((r) => !headIds.has(String(r.headId)) && !referenced.has(String(r.revisionId)));

  let lastUsed = 0;
  const byKind = {};
  for (const o of orphans) {
    byKind[o.kind] = (byKind[o.kind] || 0) + 1;
    if (o.at > lastUsed) lastUsed = o.at;
  }

  let deleted = 0;
  const t0 = performance.now();
  if (APPLY) {
    for (let i = 0; i < orphans.length; i += 500) {
      const slice = orphans.slice(i, i + 500);
      const tx = db.transaction('data-revisions', 'readwrite');
      const rs = tx.objectStore('data-revisions');
      for (const o of slice) rs.delete(o.revisionId);
      await txDone(tx);
      deleted += slice.length;
    }
  }
  const ms = Math.round(performance.now() - t0);

  const after = APPLY ? await countStore(db, 'data-revisions') : revs.length;
  db.close();

  return {
    apply: APPLY,
    before: { heads: headRows.length, revisions: revs.length },
    kept: referenced.size,
    orphans: orphans.length,
    byKind,
    newestOrphanAt: lastUsed || null,
    newestOrphanDay: lastUsed ? new Date(lastUsed).toISOString().slice(0, 10) : null,
    deleted,
    ms,
    after: { revisions: after },
    sample: orphans.slice(0, 5).map((o) => ({ revisionId: o.revisionId, headId: o.headId, kind: o.kind })),
  };
})
