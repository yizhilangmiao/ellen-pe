// 数库：heads / revisions / 各 kind / profile 分布
// 口径：heads 是「记录」，revisions 是「版本」，压测造 1 条记忆 = 1 head + 1 revision
(async (ARGS) => {
  const db = await openDB();
  const out = {
    heads: await countStore(db, 'data-heads'),
    revisions: await countStore(db, 'data-revisions'),
    byKind: {},
    profiles: await profilesInUse(db),
  };
  for (const k of ['message', 'memory', 'journal', 'emotion']) out.byKind[k] = await countKind(db, k);
  db.close();
  return out;
})
