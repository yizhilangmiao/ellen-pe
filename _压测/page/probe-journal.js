// 测手记（日记）：判该不该写 / 查今天 / 真写一篇
//
// 基准来自 _verify\M8-回归.md 第四节：写一篇 2,608 ms、查今天 19 ms、判该不该写 18 ms。
// 其中「写一篇」含模型调用，所以 ARGS.write 默认 false —— 只有真要量写盘那一段时才开，
// 开了会往库里落一条真日记，返回 headId 供 run.mjs 清场。
(async (ARGS) => {
  const WRITE = ARGS.write === true;
  if (!window.__ellen || !window.__ellen.journal) {
    return { error: '页面上没有 __ellen.journal —— 不是艾莲的 WebView，或旧包' };
  }
  const j = window.__ellen.journal;

  // ① 判该不该写：纯本地判断（今天写过没有、消息够不够），不看模型
  const t0 = performance.now();
  const due = await j.due();
  const dueMs = Math.round(performance.now() - t0);

  // ② 查今天：走 todayJournal()，库里 journal 越多越考验这个查询
  const t1 = performance.now();
  const today = await j.today();
  const todayMs = Math.round(performance.now() - t1);

  const out = {
    day: j.day(),
    dueMs,
    due: due ? { ok: due.ok, skipped: due.skipped || null, reason: due.reason || null } : due,
    todayMs,
    today: today ? { headId: today.headId || null, title: today.title || '', words: today.words || (today.diary || '').length } : null,
    wrote: null,
  };

  // ③ 真写一篇（含模型调用 + 落盘）
  //
  // 坑：writeJournal 按「天」找 head，今天已经有日记就**复用那个 head 加一条 revision**，
  // 不会新建。所以在有真日记的库里跑 force()，等于往老大今天的日记里塞一版 AI 内容。
  // 所以这里写完立刻回滚自己那一条（删 revision、把 head.last 指回原来那条），
  // 只留耗时数字。ARGS.keep === true 才保留（想真看一眼写出来什么时用）。
  if (WRITE) {
    const t2 = performance.now();
    try {
      const res = await j.force();
      const ms = Math.round(performance.now() - t2);
      out.wrote = {
        ms,
        // writeJournal 的返回不带 ok 字段，只有 headId/revisionId —— 有 id 就算写成
        ok: !!(res && (res.headId || res.revisionId)),
        headId: (res && res.headId) || null,
        revisionId: (res && res.revisionId) || null,
        revised: res && res.revised === true,
        title: (res && res.title) || '',
        err: res && res.error ? String(res.error) : null,
      };
      if (ARGS.keep !== true && out.wrote.headId && out.wrote.revisionId) {
        out.rolledBack = await rollbackOne(out.wrote.headId, out.wrote.revisionId);
      }
    } catch (e) {
      out.wrote = { ms: Math.round(performance.now() - t2), ok: false, headId: null, revisionId: null, err: String((e && e.message) || e) };
    }
  }

  return out;

  // —— 回滚：把刚写进去的那条 revision 摘掉，head.last 指回原来最后一条 ——
  async function rollbackOne(headId, revisionId) {
    const db = await openDB();
    const tx = db.transaction(['data-heads', 'data-revisions'], 'readwrite');
    const hs = tx.objectStore('data-heads');
    const rs = tx.objectStore('data-revisions');
    const h = await new Promise((res, rej) => {
      const rq = hs.get(headId);
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
    if (!h) {
      db.close();
      return { ok: false, why: 'head 不在了' };
    }
    const before = (h.revisions || []).slice();
    const kept = before.filter((x) => x !== revisionId);
    if (kept.length === before.length) {
      db.close();
      return { ok: false, why: 'head 里没有这条 revision' };
    }
    rs.delete(revisionId);
    if (kept.length === 0) {
      // 今天本来没有日记，这条 head 是 force 新建的 —— 摘完 revision 就是个空壳，一起删掉
      hs.delete(headId);
      await txDone(tx);
      db.close();
      return { ok: true, hadRevisions: before.length, nowRevisions: 0, removedHead: true };
    }
    h.revisions = kept;
    h.last = kept[kept.length - 1] || null;
    hs.put(h);
    await txDone(tx);
    db.close();
    return { ok: true, hadRevisions: before.length, nowRevisions: kept.length, removedHead: false };
  }
})
