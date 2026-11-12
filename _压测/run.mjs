#!/usr/bin/env node
/**
 * run.mjs — 压测唯一入口
 *
 *   node _压测\run.mjs --scenario memory-5000
 *   node _压测\run.mjs --scenario memory-5000 --port 9222 --keep
 *   node _压测\run.mjs --scenario memory-5000 --skip-seed      # 只测库里现成的数据
 *
 * 前置：adb 转发 WebView 调试端口（见 README 第一节）。
 *
 * 设计原则：
 *   1. 造数直插 IndexedDB，不走模型 —— 否则 5,000 条要跑一天
 *   2. 每个场景自己清场，跑完库里不留压测数据
 *   3. 数字与 _verify\M16-记忆压测.md 同口径，跑完直接对基准，不对就是脚本抄错了
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from './lib/cdp.mjs';
import { findAdb, forwardWebView } from './lib/adb.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE_DIR = join(HERE, 'page');
const OUT_DIR = join(HERE, '结果');

const argv = process.argv.slice(2);
const opt = { scenario: 'memory-5000', port: 9222, serial: '127.0.0.1:16448', adb: null, noAdb: false, keep: false, skipSeed: false, out: null };
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--scenario') opt.scenario = argv[++i];
  else if (a === '--port') opt.port = Number(argv[++i]);
  else if (a === '--serial') opt.serial = argv[++i];
  else if (a === '--adb') opt.adb = argv[++i];
  else if (a === '--no-adb') opt.noAdb = true;
  else if (a === '--out') opt.out = argv[++i];
  else if (a === '--keep') opt.keep = true;
  else if (a === '--skip-seed') opt.skipSeed = true;
  else if (a === '--help' || a === '-h') {
    console.log(readFileSync(join(HERE, 'README.md'), 'utf8').split('## 三')[0]);
    process.exit(0);
  } else {
    console.error('未知参数: ' + a);
    process.exit(2);
  }
}

// ── 场景定义：每个场景的造数参数、召回问题、判定基准 ──
const SCENARIOS = {
  'memory-5000': {
    title: '记忆 5,000 条',
    seed: { file: 'seed-memory.js', args: { count: 5000, prefix: 'memory:stress' } },
    recall: { file: 'probe-recall.js', args: { text: '你还记得我那枚吊坠吗？是什么形状的？', limit: 6, expect: '北极星' } },
    list: { file: 'probe-list.js', args: {} },
    clean: { file: 'clean.js', args: { prefix: 'memory:stress', kind: 'memory', reload: true } },
    // 基准来自 _verify\M16-记忆压测.md（2026-11-11，MuMu 实例 2）
    // 2026-11-11 21:24 起召回改走单事务批量读（recall.js 自己的旁路，library.js 一个字没动），
    // 5,000 条下首问 2,454 → 265 ms、分解 2,333 → 327 ms。区间同步下调。
    // 下界留 120 ms 是防「快得不正常」——没真读到数据也会很快。
    bench: { firstMs: [120, 1500], costTotalMs: [150, 900], listCards: 60, listFirstMs: [500, 4000] },
  },
  'journal-503': {
    title: '手记 503 篇（同库 2 万条消息）',
    seed: { file: 'seed-backup.js', args: { messages: 20018, memory: 10, journal: 503, prefix: 'seed:' } },
    // 这个场景不追「记忆里能不能找到某一条」，问的是日常问题，所以不传 expect。
    // 真实基准来自 _verify\M8-回归.md 第四节：写一篇 2,608 ms / 查今天 19 ms /
    // 判该不该写 18 ms / 回忆页首屏 201 ms。
    recall: { file: 'probe-recall.js', args: { text: '今天聊了什么？', limit: 6 } },
    journal: { file: 'probe-journal.js', args: { write: true } },
    list: { file: 'probe-list.js', args: {} },
    clean: { file: 'clean.js', args: { prefix: 'seed:', kinds: ['message', 'memory', 'journal'], reload: true } },
    // 记忆只有 30 条，卡片数够不到 60，所以不判卡片数，只判首屏耗时
    bench: { firstMs: [0, 8000], costTotalMs: [0, 2000], dueMs: [0, 500], todayMs: [0, 500], writeMs: [0, 6000], listFirstMs: [0, 3000] },
  },
  'backup-13929': {
    title: '备份 13,929 条',
    seed: { file: 'seed-backup.js', args: { messages: 12020, memory: 1504, journal: 404, prefix: 'seed:' } },
    recall: null,
    list: null,
    backup: { file: 'probe-backup.js', args: {} },
    clean: { file: 'clean.js', args: { prefix: 'seed:', kinds: ['message', 'memory', 'journal'], reload: true } },
    bench: { manifestBytes: [6000000, 9000000], runMs: [500, 3000] },
  },
};

function pageExpr(file, args) {
  const src = readFileSync(join(PAGE_DIR, file), 'utf8');
  const prelude = readFileSync(join(HERE, 'lib', 'prelude.js'), 'utf8');
  const argJson = JSON.stringify(args || {});
  return `(async () => {\n${prelude}\nreturn await (\n${src}\n)(${argJson});\n})()`;
}

const pad = (n) => String(n).padStart(2, '0');
function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}
const inRange = (v, [lo, hi]) => typeof v === 'number' && v >= lo && v <= hi;

function verdict(sc, result) {
  const rows = [];
  const b = sc.bench || {};
  if (sc.recall && result.recall) {
    const r = result.recall;
    if (b.firstMs) rows.push(['召回首问耗时', `${r.firstMs} ms`, `${b.firstMs[0]}–${b.firstMs[1]} ms`, inRange(r.firstMs, b.firstMs)]);
    if (b.costTotalMs) rows.push(['分解成本合计', `${r.costTotalMs} ms`, `${b.costTotalMs[0]}–${b.costTotalMs[1]} ms`, inRange(r.costTotalMs, b.costTotalMs)]);
    if (r.expect) rows.push([`「${r.expect}」排位`, `第 ${r.rankInFull} 名`, '前 3 名内', r.rankInFull !== null && r.rankInFull <= 3]);
  }
  if (sc.journal && result.journal) {
    const x = result.journal;
    if (b.dueMs) rows.push(['判该不该写', `${x.dueMs} ms`, `${b.dueMs[0]}–${b.dueMs[1]} ms`, inRange(x.dueMs, b.dueMs)]);
    if (b.todayMs) rows.push(['查今天', `${x.todayMs} ms`, `${b.todayMs[0]}–${b.todayMs[1]} ms`, inRange(x.todayMs, b.todayMs)]);
    if (b.writeMs) {
      if (!x.wrote) rows.push(['写一篇', '未执行', '要真写一次', false]);
      else if (!x.wrote.ok) rows.push(['写一篇', `失败：${x.wrote.err || x.wrote.skipped || '未知'}`, '要写成功', false]);
      else rows.push(['写一篇耗时', `${x.wrote.ms} ms`, `${b.writeMs[0]}–${b.writeMs[1]} ms`, inRange(x.wrote.ms, b.writeMs)]);
    }
  }
  if (sc.list && result.list) {
    const l = result.list;
    if (b.listCards != null) rows.push(['首屏卡片数', String(l.cards), `= ${b.listCards}`, l.cards === b.listCards]);
    if (b.listFirstMs) rows.push(['首屏耗时', `${l.firstMs} ms`, `${b.listFirstMs[0]}–${b.listFirstMs[1]} ms`, inRange(l.firstMs, b.listFirstMs)]);
  }
  if (sc.backup && result.backup) {
    const x = result.backup;
    if (b.manifestBytes) rows.push(['manifest 字节', String(x.manifestBytes), `${b.manifestBytes[0]}–${b.manifestBytes[1]}`, inRange(x.manifestBytes, b.manifestBytes)]);
    // 没写成就不是「快」，是没跑 —— 不能拿 3 ms 去对 500–3000 的基准
    if (b.runMs) {
      if (!x.ok) rows.push(['整包写盘', `未执行（${x.skipped || x.runErr || '原因不明'}）`, '要真跑一次', false]);
      else rows.push(['整包耗时', `${x.runMs} ms`, `${b.runMs[0]}–${b.runMs[1]} ms`, inRange(x.runMs, b.runMs)]);
    }
  }
  return rows;
}

async function main() {
  const sc = SCENARIOS[opt.scenario];
  if (!sc) throw new Error(`没有这个场景: ${opt.scenario}（可选 ${Object.keys(SCENARIOS).join(' / ')}）`);

  // 每次跑都重发 forward：APP 一重启 pid 就变，socket 名跟着变，
  // 老映射不会自己失效只会指向死 pid（症状就是 fetch failed）
  let fwd = null;
  if (!opt.noAdb) {
    fwd = forwardWebView({ adb: findAdb(opt.adb), serial: opt.serial, port: opt.port });
    console.log(`已转发端口 ${opt.port} → 艾莲 pid ${fwd.pid}（${opt.serial}）`);
  }

  const cdp = await connect(opt.port);
  console.log(`已连接：${cdp.target.title} · ${cdp.target.url}`);
  const t0 = Date.now();
  const result = {
    scenario: opt.scenario,
    title: sc.title,
    port: opt.port,
    pid: fwd ? fwd.pid : null,
    device: cdp.target,
    at: new Date().toLocaleString('zh-CN'),
  };

  try {
    result.before = await cdp.evaluate(pageExpr('counts.js', {}), { timeoutMs: 30000 });
    console.log('库规模（跑前）：', JSON.stringify(result.before.byKind), `heads=${result.before.heads}`);

    if (!opt.skipSeed && sc.seed) {
      const t = Date.now();
      result.seed = await cdp.evaluate(pageExpr(sc.seed.file, sc.seed.args), { timeoutMs: 300000 });
      result.seed.wallMs = Date.now() - t;
      const s = result.seed;
      const parts = Object.entries(s.made || {}).map(([k, v]) => `${k} ${v}`);
      const wroteTxt = parts.length ? `写 ${s.wrote} 条（${parts.join(' / ')}）` : `写 ${s.wrote} 条`;
      console.log(`造数完成：${wroteTxt}，${s.seedMs} ms（含事务）`);
      // 造数直插 IndexedDB，绕过了写入方的 invalidateRecall()；
      // 不重载的话召回索引缓存里还是旧数据，测出来的「冷启动」是假的
      const reloadMs = await cdp.reloadPage();
      console.log(`已重载页面清索引缓存（${reloadMs} ms）`);
    }

    if (sc.recall) {
      result.recall = await cdp.evaluate(pageExpr(sc.recall.file, sc.recall.args), { timeoutMs: 180000 });
      if (result.recall.error) throw new Error(result.recall.error);
      console.log(
        `召回：首问 ${result.recall.firstMs} ms / 二问 ${result.recall.secondMs} ms / 三问 ${result.recall.thirdMs} ms；` +
          `「${result.recall.expect}」全量第 ${result.recall.rankInFull} 名（score ${result.recall.scoreInFull}），分解成本 ${result.recall.costTotalMs} ms；` +
          `独立事务口径外推 ${result.recall.seqExtrapolatedMs} ms（${result.recall.seqSample} 条实耗 ${result.recall.seqSampleMs} ms）`
      );
    }

    if (sc.journal) {
      result.journal = await cdp.evaluate(pageExpr(sc.journal.file, sc.journal.args), { timeoutMs: 300000 });
      if (result.journal.error) throw new Error(result.journal.error);
      const jx = result.journal;
      console.log(
        `手记：判该不该写 ${jx.dueMs} ms（${jx.due && jx.due.skipped ? 'skipped=' + jx.due.skipped : '会写'}）/ 查今天 ${jx.todayMs} ms` +
          (jx.wrote ? ` / 写一篇 ${jx.wrote.ms} ms（${jx.wrote.ok ? '成功' : '失败 ' + (jx.wrote.err || '')}）` : ' / 未写真日记')
      );
    }

    if (sc.list) {
      result.list = await cdp.evaluate(pageExpr(sc.list.file, sc.list.args), { timeoutMs: 120000 });
      if (result.list.error) throw new Error(result.list.error);
      console.log(
        `列表首屏：${result.list.cards} 卡 / ${result.list.domNodes} 节点 / ${result.list.scrollHeight} px / ${result.list.firstMs} ms` +
          (result.list.paging ? `；翻页 ${result.list.paging.before}→${result.list.paging.after} 张 ${result.list.paging.ms} ms` : '')
      );
    }

    if (sc.backup) {
      result.backup = await cdp.evaluate(pageExpr(sc.backup.file, sc.backup.args), { timeoutMs: 180000 });
      if (result.backup.error) throw new Error(result.backup.error);
      console.log(
        `备份：manifest ${result.backup.manifestBytes} B，组包 ${result.backup.previewMs} ms；` +
          (result.backup.ok
            ? `整包 ${result.backup.packageBytes} B，${result.backup.runMs} ms`
            : `整包没写成（skipped=${result.backup.skipped || '无'}，runErr=${result.backup.runErr || '无'}）`)
      );
    }

    if (!opt.keep && sc.clean) {
      // 只按前缀清。probe-journal 写的那条由它自己回滚 —— 别指望 clean 用 headId 删，
      // 那会把今天那篇真日记整条带走（见 clean.js 顶部注释）。
      result.clean = await cdp.evaluate(pageExpr(sc.clean.file, sc.clean.args), { timeoutMs: 180000 });
      console.log(
        `清场：删 ${result.clean.matched} 条，heads ${result.clean.before.heads} → ${result.clean.after.heads}，revisions ${result.clean.before.revisions} → ${result.clean.after.revisions}`
      );
    }
  } finally {
    cdp.close();
  }

  result.verdict = verdict(sc, result);
  result.wallMs = Date.now() - t0;

  mkdirSync(OUT_DIR, { recursive: true });
  const out = opt.out ? resolve(opt.out) : join(OUT_DIR, `${stamp()}-${opt.scenario}.md`);
  writeFileSync(out, renderMd(result), 'utf8');

  console.log('\n判定：');
  for (const [name, got, want, ok] of result.verdict) console.log(`  ${ok ? 'PASS' : 'CHECK'}  ${name}: ${got}（基准 ${want}）`);
  console.log(`\n结果已写入 ${out}`);
  const bad = result.verdict.filter(([, , , ok]) => !ok);
  if (bad.length) process.exitCode = 1;
}

function renderMd(r) {
  const L = [];
  L.push(`# ${r.title} · ${r.scenario}`);
  L.push('');
  L.push(`时间：${r.at} · 端口 ${r.port} · 目标 ${r.device.title || ''} \`${r.device.url || ''}\` · 总耗时 ${Math.round(r.wallMs / 1000)} s`);
  L.push('');
  if (r.before) {
    L.push('## 一、库规模');
    L.push('');
    L.push('| 项 | 跑前 |');
    L.push('|---|---|');
    L.push(`| heads | ${r.before.heads} |`);
    L.push(`| revisions | ${r.before.revisions} |`);
    for (const [k, v] of Object.entries(r.before.byKind || {})) L.push(`| ${k} | ${v} |`);
    L.push(`| profile 分布 | ${(r.before.profiles || []).map((p) => `${p.id}=${p.n}`).join(' / ') || '空库'} |`);
    L.push('');
  }
  if (r.seed) {
    L.push('## 二、造数');
    L.push('');
    L.push(`- 写入 **${r.seed.wrote}** 条，前缀 \`${r.seed.prefix}\`，profileId \`${r.seed.profileId}\``);
    L.push(`- 库内 memory：${r.seed.memoryBefore} → **${r.seed.memoryAfter}**`);
    L.push(`- 事务耗时 **${r.seed.seedMs} ms**（含 IndexedDB 写入）`);
    L.push('');
  }
  if (r.recall) {
    const x = r.recall;
    L.push('## 三、召回');
    L.push('');
    L.push(`问：「${x.query}」`);
    L.push('');
    L.push('| 项 | 值 |');
    L.push('|---|---|');
    L.push(`| 首问（含建索引） | **${x.firstMs} ms** |`);
    L.push(`| 第二问（缓存命中） | ${x.secondMs} ms |`);
    L.push(`| 第三问（缓存命中） | ${x.thirdMs} ms |`);
    L.push(`| 分解成本 | 读 heads ${x.readHeadsMs} + 读 revisions ${x.readRevsMs} + 打分 ${x.scoreMs} = **${x.costTotalMs} ms**（单事务批量读） |`);
    L.push(
      `| 独立事务口径 | 抽样 ${x.seqSample} 条实耗 ${x.seqSampleMs} ms → 全量外推 **${x.seqExtrapolatedMs} ms**（` +
        "`library.js:51` 的 `listLatest` 就是每条一个事务） |"
    );
    L.push(`| memory heads / revisions | ${x.memoryHeads} / ${x.revisions} |`);
    if (x.expect) {
      L.push(`| 「${x.expect}」排位 | **第 ${x.rankInFull} 名**（纯字面命中），score ${x.scoreInFull}，无关次名 ${x.runnerUpScore} |`);
    }
    L.push(`| 真实链路首位 | ${(x.firstTop3[0] || {}).title || '(空)'} —— 真实口径 = 字面分 + 近 90 天时间加权，所以可能和上面不同 |`);
    L.push('');
    L.push('返回前 3：');
    for (const [i, it] of (x.firstTop3 || []).entries()) L.push(`${i + 1}. ${it.title || '(无题)'} — score ${it.score}`);
    L.push('');
    if (x.seqExtrapolatedMs && x.firstMs) {
      const ratio = (x.seqExtrapolatedMs / Math.max(x.firstMs, 1)).toFixed(1);
      L.push(
        `**读数**：召回现在走**单事务批量读**，首问 ${x.firstMs} ms = 读 heads ${x.readHeadsMs} + 读 revisions ${x.readRevsMs} + 打分 ${x.scoreMs}。` +
          `对照：同一份数据如果还走 \`library.js:51\` 的逐条 \`getOne\`（每条 head 一个事务），抽样 ${x.seqSample} 条外推要 **${x.seqExtrapolatedMs} ms**，是现在的 ${ratio} 倍。\n` +
          `慢的是**事务个数**，不是数据量。所以优化落在读法上，不在索引设计；\`library.js\` 是公共读路径没动，召回在 \`recall.js\` 里开了旁路。`
      );
      L.push('');
    }
  }
  if (r.journal) {
    const x = r.journal;
    L.push('## 四、手记（日记）');
    L.push('');
    L.push('| 项 | 值 |');
    L.push('|---|---|');
    L.push(`| 今天 | \`${x.day}\` |`);
    L.push(`| 判该不该写 | **${x.dueMs} ms**（${x.due && x.due.skipped ? '结论 skipped=' + x.due.skipped : '结论=会写'}） |`);
    L.push(`| 查今天 | **${x.todayMs} ms**${x.today && x.today.headId ? `，取到「${x.today.title || x.today.headId}」` : '，今天还没有'} |`);
    if (x.wrote) {
      L.push(`| 写一篇（含模型） | ${x.wrote.ok ? `**${x.wrote.ms} ms**` : `失败 —— \`${x.wrote.err}\``} |`);
    } else {
      L.push('| 写一篇 | 未执行（`ARGS.write` 不开，避免往库里落真日记） |');
    }
    L.push('');
  }
  if (r.list) {
    const x = r.list;
    L.push('## 五、记忆列表首屏');
    L.push('');
    L.push('| 项 | 值 |');
    L.push('|---|---|');
    L.push(`| 首屏卡片 | **${x.cards}** |`);
    L.push(`| DOM 节点 | ${x.domNodes} |`);
    L.push(`| 滚动高度 | ${x.scrollHeight} px |`);
    L.push(`| 首屏耗时 | **${x.firstMs} ms** |`);
    if (x.paging) L.push(`| 翻页 | ${x.paging.before} → ${x.paging.after} 张，${x.paging.ms} ms，标签「${x.paging.label}」 |`);
    L.push('');
  }
  if (r.backup) {
    const x = r.backup;
    L.push('## 六、备份');
    L.push('');
    L.push('| 项 | 值 |');
    L.push('|---|---|');
    L.push(`| manifest | **${x.manifestBytes} B** |`);
    L.push(`| 组包耗时（不落盘） | ${x.previewMs} ms |`);
    if (x.ok) {
      L.push(`| 整包 | **${x.packageBytes} B** |`);
      L.push(`| 整包耗时 | **${x.runMs} ms** |`);
    } else {
      L.push(`| 整包 | 未写成 —— \`skipped=${x.skipped || '无'}\` ${x.runErr ? `\`err=${x.runErr}\`` : ''} |`);
    }
    if (x.state) {
      L.push(
        `| 备份状态 | supported=${x.state.supported} · enabled=${x.state.enabled} · ` +
          `目录 \`${x.state.directory || '(空)'}\` · 已存 ${x.state.groups} 组 |`
      );
    }
    L.push('');
    if (!x.ok) {
      L.push(
        '> `run()` 有四个前置门槛：`supported` / `enabled` / `directory` / `writing`，任一条不满足就直接返回，' +
          '几毫秒结束 —— 那不是「备份很快」，是**压根没备份**。目录 \`(空)\` 表示这台设备没做过 SAF 授权，' +
          '整包写盘这一步自动跑不了，需要在设置页手点一次「选择备份文件夹」。'
      );
      L.push('');
    }
  }
  if (r.clean) {
    const x = r.clean;
    L.push('## 七、清场');
    L.push('');
    L.push(
      `按前缀 \`${x.prefix}\` 删 **${x.matched}** 条（${x.ms} ms）：heads ${x.before.heads} → **${x.after.heads}**，revisions ${x.before.revisions} → **${x.after.revisions}**。`
    );
    for (const k of x.kinds || []) {
      L.push(`- ${k}：${x.before.byKind[k]} → ${x.after.byKind[k]}`);
    }
    if (x.reload) L.push('（页面已自动刷新，清掉内存里的召回索引缓存）');
    L.push('');
  }
  if (r.verdict && r.verdict.length) {
    L.push('## 八、判定');
    L.push('');
    L.push('| 项 | 实测 | 基准 | 结论 |');
    L.push('|---|---|---|---|');
    for (const [name, got, want, ok] of r.verdict) L.push(`| ${name} | ${got} | ${want} | ${ok ? '**PASS**' : 'CHECK'} |`);
    L.push('');
  }
  return L.join('\n');
}

main().catch((e) => {
  console.error('[压测失败]', e.message);
  process.exit(1);
});
