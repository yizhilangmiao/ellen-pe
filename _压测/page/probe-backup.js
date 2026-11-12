// 测备份：先 dry（只组 manifest，不落盘），再真跑一次整包
//
// 注意：run() 会往「文档」目录写一个包，压测反复跑会攒包。
// 只在需要时跑，或者先 configure({ retainGroups: 1 }) 少留几组。
(async (ARGS) => {
  if (!window.__ellen || !window.__ellen.exportPreview) {
    return { error: '页面上没有 __ellen.exportPreview —— 不是艾莲的 WebView，或旧包' };
  }

  // ① dry：只组包，不写文件。用来量「组包」这一段本身的成本
  const t0 = performance.now();
  const preview = await window.__ellen.exportPreview();
  const previewMs = Math.round(performance.now() - t0);

  // ② 真跑：写整包。force=true 跳过「备份没开」的门槛
  const t1 = performance.now();
  let run = null;
  let runErr = null;
  try {
    run = await window.__ellen.backup.run({ force: true });
  } catch (e) {
    runErr = String((e && e.message) || e);
  }
  const runMs = Math.round(performance.now() - t1);

  const stats = (run && run.stats) || preview.stats || {};
  const group = (run && run.group) || null;

  // run() 有四个前置门槛（supported / enabled / directory / writing），
  // 任一条不满足就直接 skipped 返回，几毫秒就结束 —— 那不是「备份很快」，
  // 是压根没备份。所以这里把 skipped 和当时的 state 一起带出去。
  let st = null;
  try {
    st = await window.__ellen.backup.state();
  } catch {
    /* 旧包可能没有 state，不影响其它字段 */
  }

  return {
    previewMs,
    manifestBytes: Number(stats.manifestBytes || preview.manifestBytes || 0),
    heads: stats.heads != null ? stats.heads : stats.total,
    byKind: stats.byKind || null,
    packageBytes: group ? Number(group.bytes || group.size || 0) || null : null,
    groupName: group ? group.name || group.id || null : null,
    pruned: (run && run.pruned) || [],
    runMs,
    ok: !!(run && run.ok),
    skipped: run ? run.skipped || null : null,
    runErr,
    state: st
      ? {
          supported: st.supported,
          enabled: st.enabled,
          directory: st.directory || '',
          directoryName: st.directoryName || '',
          retainGroups: st.retainGroups,
          groups: (st.groups || []).length,
        }
      : null,
  };
})
