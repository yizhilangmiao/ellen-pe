// 验「单事务批量读」和「逐条独立事务」在同一份数据上结果是否一致、快多少。
//
// 背景：core/chat/recall.js 的 buildIndex 原来调 store/library.js 的 listLatest，
// 后者在 library.js:51 对每条 head 各起一个独立事务（5,020 条 head = 5,020 个事务）。
// 现在 recall 自己开旁路，用一个事务把 heads + 末条 revision 读完。
//
// 这个探针不碰运行中的代码：它把两套读法都复刻一遍，在同一份真实数据上跑，
// 比「条数 / 顺序 / headId / revisionId」和耗时。三样全等才算等价。
//
// ARGS: { kinds?: string[] }   默认 ['memory','journal']
(async (ARGS) => {
  const HEADS = 'data-heads';
  const REVS = 'data-revisions';
  const kinds = Array.isArray(ARGS.kinds) && ARGS.kinds.length ? ARGS.kinds : ['memory', 'journal'];
  const db = await openDB();

  // ── 复刻 1：library.js 的 listLatest（逐条独立事务） ──────────────
  function pickHeads(all) {
    const alive = (all || []).filter(
      (h) => h && !h.deleted && Array.isArray(h.revisions) && h.revisions.length,
    );
    alive.sort((a, b) => {
      const ta = Number.isFinite(a.messageTime) ? a.messageTime : a.createdAt || 0;
      const tb = Number.isFinite(b.messageTime) ? b.messageTime : b.createdAt || 0;
      return tb - ta;
    });
    return alive;
  }

  function pGetAll(index, q) {
    return new Promise((res, rej) => {
      const t = db.transaction(HEADS, 'readonly');
      const r = t.objectStore(HEADS).index(index).getAll(q);
      r.onsuccess = () => res(r.result || []);
      r.onerror = () => rej(r.error);
    });
  }

  function pGetOne(key) {
    return new Promise((res, rej) => {
      const t = db.transaction(REVS, 'readonly');
      const r = t.objectStore(REVS).get(key);
      r.onsuccess = () => res(r.result || null);
      r.onerror = () => rej(r.error);
    });
  }

  async function oldWay(kind) {
    const out = [];
    for (const h of pickHeads(await pGetAll('kind', kind))) {
      const last = h.revisions[h.revisions.length - 1];
      const rev = await pGetOne(last);
      if (!rev || rev.deleted) continue;
      out.push({ headId: h.id, revisionId: rev.revisionId, at: rev.at });
    }
    return out;
  }

  // ── 复刻 2：recall.js 新加的 readLatestOneTx（一个事务） ────────────
  function newWay(kind) {
    return new Promise((res, rej) => {
      const t = db.transaction([HEADS, REVS], 'readonly');
      const rs = t.objectStore(REVS);
      const out = [];
      const hs = t.objectStore(HEADS).index('kind').getAll(kind);
      hs.onerror = () => rej(hs.error);
      hs.onsuccess = () => {
        for (const h of pickHeads(hs.result)) {
          const r = rs.get(h.revisions[h.revisions.length - 1]);
          r.onsuccess = () => {
            const rev = r.result;
            if (!rev || rev.deleted) return;
            out.push({ headId: h.id, revisionId: rev.revisionId, at: rev.at });
          };
        }
      };
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error || new Error('newWay tx error'));
      t.onabort = () => rej(t.error || new Error('newWay tx abort'));
    });
  }

  const perKind = [];
  let consistent = true;

  for (const kind of kinds) {
    const t0 = performance.now();
    const a = await oldWay(kind);
    const oldMs = Math.round(performance.now() - t0);

    const t1 = performance.now();
    const b = await newWay(kind);
    const newMs = Math.round(performance.now() - t1);

    const sameLen = a.length === b.length;
    const sameOrder =
      sameLen && a.every((x, i) => x.headId === b[i].headId && x.revisionId === b[i].revisionId);
    if (!sameOrder) consistent = false;

    perKind.push({
      kind,
      count: a.length,
      oldMs,
      newMs,
      speedup: newMs > 0 ? Number((oldMs / newMs).toFixed(2)) : null,
      sameLen,
      sameOrder,
      firstOld: a[0] || null,
      firstNew: b[0] || null,
      lastOld: a[a.length - 1] || null,
      lastNew: b[b.length - 1] || null,
    });
  }

  db.close();
  return { kinds, consistent, perKind };
})
