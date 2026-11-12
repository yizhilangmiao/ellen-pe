// 测召回：真实链路（含索引缓存）+ 分解成本（与 M16 的 544ms 同口径）
//
// 两段分开看的原因：
//   真实链路回答「用户要等多久」，含建索引、渲染条目；
//   分解成本回答「慢在哪」，是读 heads / 读 revisions / 打分三段。
// 只有分解成本能和 _verify\M16-记忆压测.md 的数字直接比。
(async (ARGS) => {
  const text = String(ARGS.text || '你还记得我那枚吊坠吗？是什么形状的？');
  const limit = Number(ARGS.limit || 6);
  // 不传 expect 就不排名次（journal 场景问的是「今天聊了什么」，没有指定靶子）
  const expectKey = String(ARGS.expect || '');

  if (!window.__ellen || typeof window.__ellen.recall !== 'function') {
    return { error: '页面上没有 window.__ellen.recall —— 这不是艾莲的 WebView，或起的是旧包' };
  }

  const pick = (list) =>
    (list || []).map((x) => ({
      title: x.title || x.summary || '',
      kind: x.kind,
      score: x.score,
      hit: x.hit,
      at: x.at,
    }));

  // —— 真实链路：连跑三次，第 1 次含建索引 ——
  const t0 = performance.now();
  const first = await window.__ellen.recall(text, { limit });
  const firstMs = Math.round(performance.now() - t0);

  const t1 = performance.now();
  const second = await window.__ellen.recall(text, { limit });
  const secondMs = Math.round(performance.now() - t1);

  const t2 = performance.now();
  const third = await window.__ellen.recall(text, { limit });
  const thirdMs = Math.round(performance.now() - t2);

  const firstList = pick(first);
  const rankInFirst = expectKey ? firstList.findIndex((x) => String(x.title).includes(expectKey)) : -1;

  // —— 分解成本：直插 IDB 全量读 + 复刻 bigram 打分 ——
  function tokens(src) {
    const out = new Set();
    const s = String(src || '')
      .toLowerCase()
      .replace(/[\s\u3000]+/g, ' ')
      .replace(/[，。！？、；：""''（）《》…—·~,.!?;:"'()<>[\]{}/\\|@#$%^&*+=_`]/g, ' ');
    for (const part of s.split(' ')) {
      if (!part) continue;
      if (/^[a-z0-9]+$/.test(part)) {
        if (part.length >= 2) out.add(part);
        continue;
      }
      const chars = [...part];
      if (chars.length === 1) {
        out.add(part);
        continue;
      }
      for (let i = 0; i + 1 < chars.length; i += 1) out.add(chars[i] + chars[i + 1]);
    }
    return out;
  }

  const db = await openDB();
  const c0 = performance.now();
  const heads = await new Promise((res, rej) => {
    const out = [];
    const c = db.transaction('data-heads', 'readonly').objectStore('data-heads').openCursor();
    c.onsuccess = () => {
      const cur = c.result;
      if (!cur) return res(out);
      if (cur.value.kind === 'memory') out.push(cur.value);
      cur.continue();
    };
    c.onerror = () => rej(c.error);
  });
  const readHeadsMs = Math.round(performance.now() - c0);

  const c1 = performance.now();
  const revIds = heads.flatMap((h) => h.revisions || []);
  const revs = new Map();
  await new Promise((res, rej) => {
    const tx = db.transaction('data-revisions', 'readonly');
    for (const rid of revIds) {
      const rq = tx.objectStore('data-revisions').get(rid);
      rq.onsuccess = () => {
        if (rq.result) revs.set(rid, rq.result);
      };
    }
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
  const readRevsMs = Math.round(performance.now() - c1);

  const c2 = performance.now();
  const q = tokens(text);
  const scored = [];
  for (const h of heads) {
    const rev = revs.get((h.revisions || [])[0]);
    const v = (rev && rev.value) || {};
    const bag = tokens([v.title, v.summary, v.body].filter(Boolean).join(' '));
    let hit = 0;
    for (const t of bag) if (q.has(t)) hit += 1;
    const score = bag.size ? hit / Math.sqrt(bag.size) : 0;
    scored.push({ id: h.id, title: v.title || '', score });
  }
  const scoreMs = Math.round(performance.now() - c2);
  scored.sort((a, b) => b.score - a.score);

  // —— 对照：listLatest() 是「每条 head 一个独立事务 getOne」（library.js:51）
  // 上面 readRevsMs 是「一个事务里发 N 个 get」。差多少，就是 listLatest 的真实代价。
  // 取前 500 条量一下，别拖太久。
  const sample = revIds.slice(0, 500);
  const c3 = performance.now();
  let got = 0;
  for (const rid of sample) {
    const v = await new Promise((res, rej) => {
      const rq = db.transaction('data-revisions', 'readonly').objectStore('data-revisions').get(rid);
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
    if (v) got += 1;
  }
  const seqGetMs = Math.round(performance.now() - c3);
  db.close();

  const at0 = expectKey ? scored.findIndex((x) => String(x.title).includes(expectKey)) : -1;
  // 「次名」= 除目标之外的最高分。别用 scored[1]，目标自己排第二时会同分
  const other = expectKey ? scored.find((x) => !String(x.title).includes(expectKey)) : scored[1] || null;
  return {
    query: text,
    expect: expectKey,
    // 真实链路
    firstMs,
    secondMs,
    thirdMs,
    firstTop3: firstList.slice(0, 3),
    rankInFirst: rankInFirst >= 0 ? rankInFirst + 1 : null,
    // 分解成本
    memoryHeads: heads.length,
    revisions: revs.size,
    readHeadsMs,
    readRevsMs,
    scoreMs,
    costTotalMs: readHeadsMs + readRevsMs + scoreMs,
    // 独立事务口径：listLatest() 的真实写法
    seqSample: sample.length,
    seqSampleMs: seqGetMs,
    seqExtrapolatedMs: sample.length ? Math.round((seqGetMs / sample.length) * revIds.length) : null,
    rankInFull: at0 >= 0 ? at0 + 1 : null,
    scoreInFull: at0 >= 0 ? Number(scored[at0].score.toFixed(3)) : null,
    runnerUpScore: other ? Number(other.score.toFixed(3)) : null,
  };
})
