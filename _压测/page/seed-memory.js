// 造记忆：直插 IndexedDB（不过模型、不过 write 路径，才压得动 5,000 条）
//
// ⚠ 两个 schema 坑（踩过，别改）：
//   1) data-revisions 的 keyPath 是 revisionId，不是 id
//   2) head.revisions 数组里放的是 revisionId
//   写错任何一处，listLatest 会把这些 head 当成「没有 revision」整条跳过，
//   库里数得到、页面上一张都不出。
(async (ARGS) => {
  const N = Number(ARGS.count || 5000);
  const PREFIX = String(ARGS.prefix || 'memory:stress');
  const BATCH = 500;
  const topics = [
    '橘子', '豆豆', '加班', '下雨', '钥匙', '灯泡', '地铁', '体检', '咖啡', '锅贴',
    '生日', '山路', '旧手机', '衬衫', '台风', '作业', '月饼', '嗓子', '护照', '阳台',
  ];

  const db = await openDB();
  // profileId 跟现库走：全空库才退回 profile:default
  const profiles = await profilesInUse(db);
  const profileId = (profiles.find((p) => p.id && p.id !== '(none)') || { id: 'profile:default' }).id;

  const before = await countKind(db, 'memory');
  const now = nowMs();
  const t0 = performance.now();
  let wrote = 0;

  for (let start = 0; start < N; start += BATCH) {
    const heads = [];
    const revs = [];
    const end = Math.min(start + BATCH, N);
    for (let i = start; i < end; i += 1) {
      const id = `${PREFIX}-${i}`;
      // i=0 最老（N*6h 之前 ≈ 3 年），时间戳用来验「很久以前的还能不能被想起」
      const at = now - (N - i) * 6 * 3600 * 1000;
      const topic = i === 0 ? '北极星吊坠' : topics[i % topics.length];
      const value = {
        namespace: 'ellen.memory',
        version: 1,
        title: i === 0 ? '北极星吊坠' : `${topic}第${i}次`,
        summary:
          i === 0
            ? '他有一枚北极星形状的吊坠，说那是妈妈留下的，只在很难过的时候拿出来看。'
            : `这件事跟${topic}有关，第${i}次提起。`,
        body: '',
        tags: [topic],
        scope: i % 2 ? 'shared' : 'past',
        at,
        createdAt: at,
        updatedAt: at,
        sourceIds: [],
        editedBy: 'seed',
      };
      const revisionId = `${id}:r1`;
      heads.push({
        id,
        kind: 'memory',
        profileId,
        revisions: [revisionId],
        conflict: 0,
        deleted: false,
        threadId: null,
        createdAt: at,
        messageTime: at,
        threadKeys: [],
      });
      revs.push({
        revisionId,
        id,
        headId: id,
        kind: 'memory',
        profileId,
        parents: [],
        origin: { deviceId: 'seed' },
        at,
        deleted: false,
        value,
        refs: [],
      });
    }
    const tx = db.transaction(['data-heads', 'data-revisions'], 'readwrite');
    const hs = tx.objectStore('data-heads');
    const rs = tx.objectStore('data-revisions');
    heads.forEach((x) => hs.put(x));
    revs.forEach((x) => rs.put(x));
    await txDone(tx);
    wrote += heads.length;
  }

  const seedMs = Math.round(performance.now() - t0);
  const after = await countKind(db, 'memory');
  db.close();
  return { prefix: PREFIX, profileId, wrote, seedMs, memoryBefore: before, memoryAfter: after };
})
