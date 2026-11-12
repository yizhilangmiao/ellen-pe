// 造三类数据：message / memory / journal（备份压测与手记压测共用）
// 参数：{ messages, memory, journal, prefix }
(async (ARGS) => {
  const cfgs = [
    { kind: 'message', n: Number(ARGS.messages || 0) },
    { kind: 'memory', n: Number(ARGS.memory || 0) },
    { kind: 'journal', n: Number(ARGS.journal || 0) },
  ].filter((c) => c.n > 0);

  if (!cfgs.length) return { error: '三个数字都是 0，没东西可造' };

  const PREFIX = String(ARGS.prefix || 'seed:');
  const BATCH = 1000;
  const threads = [`${PREFIX}thread-a`, `${PREFIX}thread-b`];

  const db = await openDB();
  const profiles = await profilesInUse(db);
  const profileId = (profiles.find((p) => p.id && p.id !== '(none)') || { id: 'profile:default' }).id;
  const deviceId = localStorage.getItem('ellen.device') || 'seed-device';

  // 文本长度对齐真实聊天记录（约 120 字），让 JSON 体积别失真
  const textOf = (kind, i) => {
    if (kind === 'message')
      return `这是第 ${i} 条压力测试消息，用来验证备份在大数据量下不炸。内容长度大概一百二十个字左右，包含中文、标点，还有偶尔出现的英文 token 和数字 12345，让 JSON 序列化的体积更接近真实聊天记录。`;
    if (kind === 'memory')
      return `关于豆豆的第 ${i} 段记忆：他那天在楼下便利店买了橘子，回来的时候猫正在沙发上睡，窗外下着小雨。`;
    return `第 ${i} 天的手记：今天聊了很多琐碎的事，晚饭是番茄鸡蛋面，他说累了想早点睡。`;
  };

  const before = {};
  const made = {};
  const base = nowMs() - 86400 * 1000;
  const t0 = performance.now();

  for (const cfg of cfgs) {
    before[cfg.kind] = await countKind(db, cfg.kind);
    let done = 0;
    while (done < cfg.n) {
      const batch = Math.min(BATCH, cfg.n - done);
      const tx = db.transaction(['data-heads', 'data-revisions'], 'readwrite');
      const hs = tx.objectStore('data-heads');
      const rs = tx.objectStore('data-revisions');
      for (let i = 0; i < batch; i += 1) {
        const idx = done + i;
        const at = base + idx * 1000;
        const headId = `${PREFIX}${cfg.kind}:${idx}`;
        const revisionId = `${PREFIX}rev-${cfg.kind}-${idx}`;
        const threadId = cfg.kind === 'message' ? threads[idx % threads.length] : null;
        const value =
          cfg.kind === 'message'
            ? { threadId, role: idx % 2 ? 'assistant' : 'user', text: textOf(cfg.kind, idx), at }
            : { body: textOf(cfg.kind, idx), at, title: `${cfg.kind}-${idx}` };
        rs.put({
          revisionId,
          id: headId,
          headId,
          kind: cfg.kind,
          profileId,
          parents: [],
          origin: { deviceId, platform: 'android' },
          at,
          deleted: false,
          value,
          refs: [],
        });
        hs.put({
          id: headId,
          kind: cfg.kind,
          profileId,
          threadId,
          createdAt: at,
          messageTime: at,
          revisions: [revisionId],
          conflict: false,
          deleted: false,
          threadKeys: threadId ? [threadId] : [],
        });
      }
      await txDone(tx);
      done += batch;
    }
    made[cfg.kind] = cfg.n;
  }

  const seedMs = Math.round(performance.now() - t0);
  const after = {};
  for (const cfg of cfgs) after[cfg.kind] = await countKind(db, cfg.kind);
  db.close();
  // wrote / memoryBefore / memoryAfter 是为了和 seed-memory.js 的返回结构对齐，
  // run.mjs 的渲染只认这三个字段
  const wrote = Object.values(made).reduce((a, b) => a + b, 0);
  return {
    prefix: PREFIX,
    profileId,
    made,
    wrote,
    seedMs,
    before,
    after,
    memoryBefore: before.memory || 0,
    memoryAfter: after.memory || 0,
  };
})
