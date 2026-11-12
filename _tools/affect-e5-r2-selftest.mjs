// E5（情绪沉淀进手记）+ R2（语义召回可降级）的脱机验收。
//
// 跑法： E:\ailian\工具\node\node-v24.21.0-win-x64\node.exe _tools\affect-e5-r2-selftest.mjs
//
// 为什么召回要「探针」而不能直接 import：
//   recall.js 顶部 import 了 store/db.js，它在模块内就调 indexedDB —— node 里没有这东西，
//   直接 import 测的就变成环境了。所以把 recall.js 原文抄一份到 _tools/_tmp/，只把
//   openDb/listLatest 两条 import 换成桩，其余一个字不改地跑真代码。
//   桩里让 openDb 直接 reject（模拟「单事务批量读失败」），正好顺带走一遍它的回退分支。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalizeState, settle, sampleNow, dayStats, serialize, loadAffect } from '../app/web/src/app/core/affect.js';
import { moodAppendix, stripAppendix, attachJournalMood } from '../app/web/src/app/core/ritual.js';

const HOUR = 3600e3;

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  [PASS] ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail += 1;
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
function head(t) {
  console.log(`\n== ${t} ==`);
}

/** 内存版 meta 存储（形状与 records.js 一致）。 */
function memStore() {
  const map = new Map();
  return {
    map,
    async getMeta(key, fallback = null) {
      return map.has(key) ? map.get(key) : fallback;
    },
    async putMeta(key, value) {
      map.set(key, JSON.parse(JSON.stringify(value)));
      return true;
    },
  };
}

// ── E5-① 采样 ────────────────────────────────────────────────
head('E5-① 每小时最多一条、最多 24 条');
{
  const t0 = new Date(2026, 10, 13, 0, 3, 0).getTime();
  const state = normalizeState(null, t0);
  let added = 0;
  let dup = 0;
  // 连跑 48 小时，每小时里读四次（模拟一分钟读一次）
  for (let h = 0; h < 48; h += 1) {
    for (let q = 0; q < 4; q += 1) {
      const now = t0 + h * HOUR + q * 15 * 60e3;
      settle(state, now);
      const r = sampleNow(state, now);
      if (r.added) added += 1;
      else dup += 1;
    }
  }
  ok('48 小时只记 24 条采样', state.samples.length === 24, `实得 ${state.samples.length} 条`);
  ok('每小时只记一次（同一小时重复读不写）', added === 48 && dup === 192 - 48, `记 ${added} 次、跳过 ${dup} 次`);
  const buckets = new Set(state.samples.map((s) => Math.floor(s.at / HOUR)));
  ok('样本没有重复的小时桶', buckets.size === state.samples.length, `${buckets.size}/${state.samples.length}`);
  const last = state.samples[state.samples.length - 1];
  const twoDecimals = (v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-9;
  ok('采样里的数是两位小数以内', Object.values(last.dims).every(twoDecimals), `lust=${last.dims.lust}`);

  const stats = dayStats(state, state.samples[state.samples.length - 1].at);
  ok('当日统计给出均值/峰值', stats.count > 0 && stats.moodAvg > 0 && stats.moodPeak >= stats.moodAvg, `count=${stats.count} avg=${stats.moodAvg} peak=${stats.moodPeak}`);
  ok('当日统计带 dimsAtClose（七维）', Object.keys(stats.dimsAtClose).length === 7);
}

head('E5-①b 落盘体积（序列化不膨胀）');
{
  const t0 = new Date(2026, 10, 13, 1, 0, 0).getTime();
  const state = normalizeState(null, t0);
  for (let h = 0; h < 30; h += 1) sampleNow(state, t0 + h * HOUR);
  const json = JSON.stringify(serialize(state));
  ok('24 条样本的落盘 JSON 小于 3 KB', json.length < 3000, `${json.length} 字节`);
  ok('落盘样本数不超过 24', JSON.parse(json).samples.length === 24);
}

// ── E5-①c 采样真的走到落盘（跑整条 loadAffect 路径）──────────────
head('E5-①c 读路径就会采样、并且落盘');
{
  const store = memStore();
  const t0 = new Date(2026, 10, 13, 9, 10, 0).getTime();
  const s1 = await loadAffect({ store, now: t0 });
  ok('第一次读就记了一条', s1.samples.length === 1, `${s1.samples.length} 条`);
  const persisted1 = await store.getMeta('mood-v1', null);
  ok('样本进了 mood-v1', Array.isArray(persisted1.samples) && persisted1.samples.length === 1);

  // 同一小时内再读三次：不新增
  for (let i = 1; i <= 3; i += 1) await loadAffect({ store, now: t0 + i * 60e3 });
  const mid = await loadAffect({ store, now: t0 + 20 * 60e3 });
  ok('同一小时内读多次仍只有一条', mid.samples.length === 1, `${mid.samples.length} 条`);

  // 跨到下一个小时：+1 条
  const next = await loadAffect({ store, now: t0 + HOUR + 60e3 });
  ok('过了一小时多一条', next.samples.length === 2, `${next.samples.length} 条`);

  // 只读调用不该改状态（调试页/每轮提示词都走 persist:false）
  const readonly = await loadAffect({ store, now: t0 + 5 * HOUR, persist: false });
  ok('persist:false 不采样', readonly.samples.length === 2, `${readonly.samples.length} 条`);
}


head('E5-② 情绪附录写进手记');
{
  const t0 = new Date(2026, 10, 13, 22, 40, 0).getTime();
  const state = normalizeState(null, t0);
  for (let h = 0; h < 6; h += 1) sampleNow(state, t0 - (6 - h) * HOUR);
  state.dims.affection = 22;
  state.dims.lust = 18;
  const appendix = moodAppendix(state, t0);
  ok('附录带（情绪）标记', appendix.startsWith('（情绪）'), appendix.slice(0, 24));
  ok('附录含当日均值与峰值', /平均 [\d.]+、最高 [\d.]+（\d\d:\d\d）/.test(appendix), appendix);
  ok('附录点出「冷」的类型（三种冷分开）', appendix.includes('心冷') && appendix.includes('身体冷'), appendix);
  ok('附录压在一行的长度（≤120 汉字）', appendix.length <= 120, `${appendix.length} 字`);

  const writes = [];
  let existing = { headId: 'h1', value: { day: '2026-11-13', title: '今天', diary: '他今天很早就回来了。', thoughts: '有点累，但心里踏实。' } };
  const hooks = {
    loadAffect: async () => state,
    journal: {
      todayJournal: async () => existing,
      writeJournal: async (payload) => {
        writes.push(payload);
        existing = { headId: 'h1', value: { ...existing.value, ...payload } };
        return { headId: 'h1', day: payload.day, revised: true };
      },
    },
  };
  const r1 = await attachJournalMood({ now: t0, hooks });
  ok('晚安时把手记写回去', r1.ok === true && writes.length === 1, JSON.stringify(r1.reason || 'ok'));
  ok('正文没被情绪盖掉', writes[0].diary.includes('他今天很早就回来了'), writes[0].diary);
  ok('原来的想法还在', writes[0].thoughts.includes('心里踏实'), writes[0].thoughts);
  ok('情绪附录进了 thoughts', writes[0].thoughts.includes('（情绪）'), writes[0].thoughts.slice(-40));

  // 再写一次：附录是替换不是追加（不然一篇手记里会叠出十段情绪）
  await attachJournalMood({ now: t0 + 60e3, hooks });
  const countTag = (writes[1].thoughts.match(/（情绪）/g) || []).length;
  ok('重写时旧附录被替换、不叠加', countTag === 1, `出现 ${countTag} 次`);
  ok('stripAppendix 只摘附录不动正文', stripAppendix('正文一句。\n\n（情绪）今天平均 1') === '正文一句。');

  // 今天还没有手记：不许新开一篇空壳，附录交给 ritual 的 meta 存着
  const r2 = await attachJournalMood({
    now: t0,
    hooks: { loadAffect: async () => state, journal: { todayJournal: async () => null, writeJournal: async () => ({}) } },
  });
  ok('没有手记时不写空壳，只回 appendix', r2.ok === false && r2.reason === 'noJournal' && !!r2.appendix);
}

// ── R2 探针：把 recall.js 抄一份，只换掉存储两条 import ─────────
head('R2-准备 载入 recall 探针');
const probe = await loadRecallProbe();
const { recall, recallable, entryView, queryOf, scoreEntry, literalScorer, semanticScorer, conceptsOf } = probe;
ok('探针加载成功（真 recall 代码 + 假存储）', typeof recall === 'function' && typeof semanticScorer === 'function');

// ── R2-③ 语义分高于字面分 / 状态闸不许绕过 ──────────────────────
head('R2-③ 同义句语义分更高');
{
  const q = queryOf('那部电影没看完');
  const view = entryView({
    kind: 'memory',
    at: Date.now(),
    value: { title: '电影', summary: '电影我睡着了', evidenceAt: Date.now() },
  });
  const literal = literalScorer()(q, view);
  const semantic = semanticScorer()(q, view);
  ok('字面分有基础分（共享「电影」）', literal > 0, `literal=${literal.toFixed(3)}`);
  ok('语义分高于字面分', semantic > literal, `semantic=${semantic.toFixed(3)} > literal=${literal.toFixed(3)}`);
  ok('语义分不超过 1', semantic <= 1, semantic.toFixed(3));
  ok('概念表认得「电影」与「睡着」', conceptsOf('电影我睡着了').has('movie') && conceptsOf('电影我睡着了').has('sleep'));

  const unrelated = entryView({ kind: 'memory', at: Date.now(), value: { summary: '今天加班到十点' } });
  ok('不相干的事分数低', semanticScorer()(q, unrelated) < 0.35, semanticScorer()(q, unrelated).toFixed(3));

  // 状态闸
  ok('active 可召回', recallable({ value: { state: 'active' } }) === true);
  ok('已翻篇（superseded）不可召回', recallable({ value: { state: 'superseded' } }) === false);
  ok('已退役（retired）不可召回', recallable({ value: { state: 'retired' } }) === false);
  ok('muted 不可召回', recallable({ value: { muted: true } }) === false);
  ok('老数据没 state 字段照样可召回', recallable({ value: { title: '旧记忆' } }) === true);
}

head('R2-③b 端到端：翻篇的记忆真的进不来');
{
  const now = Date.now();
  const mk = (id, value) => ({
    headId: id,
    kind: 'memory',
    threadId: null,
    revisionId: `${id}-r1`,
    at: value.evidenceAt || now - HOUR,
    createdAt: now - HOUR,
    value,
    refs: [],
  });
  globalThis.__RECALL_FAKE__ = {
    byKind: {
      memory: [
        mk('m1', { title: '电影', summary: '电影我睡着了', state: 'active', evidenceAt: now - 2 * HOUR }),
        mk('m2', { title: '电影', summary: '那部电影我们没看完', state: 'superseded', evidenceAt: now - 2 * HOUR }),
        mk('m3', { title: '电影', summary: '电影票根别扔', state: 'retired', evidenceAt: now - 2 * HOUR }),
      ],
      journal: [],
    },
  };
  probe.invalidateRecall();
  const hits = await recall('那部电影没看完', { scorer: 'semantic', limit: 6, minScore: 0.16 });
  const titles = hits.map((h) => `${h.title}:${h.body}`);
  ok('召回到了活跃的那条', titles.some((t) => t.includes('睡着了')), titles.join(' | '));
  ok('翻篇的记忆召回不到', !titles.some((t) => t.includes('没看完')), titles.join(' | '));
  ok('退役的记忆召回不到', !titles.some((t) => t.includes('票根')), titles.join(' | '));

  const literalHits = await recall('那部电影没看完', { limit: 6, minScore: 0.16 });
  ok('不传 scorer = 字面（老行为）', literalHits.length > 0 && literalHits[0].title === '电影', literalHits.map((h) => h.hit).join(','));
}

// ── R2-④ scorer 抛错 → 静默退回字面 ───────────────────────────
head('R2-④ scorer 坏掉时不当机');
{
  const q = queryOf('那部电影没看完');
  const view = entryView({ kind: 'memory', at: Date.now(), value: { summary: '电影我睡着了' } });
  const literal = literalScorer()(q, view);
  const boom = () => {
    throw new Error('scorer 炸了');
  };
  ok('scoreEntry 退回字面分', Math.abs(scoreEntry(q, view, boom) - literal) < 1e-9, `${scoreEntry(q, view, boom).toFixed(3)} vs ${literal.toFixed(3)}`);
  const nan = scoreEntry(q, view, () => Number.NaN);
  ok('scorer 返回 NaN 也退回字面分', Math.abs(nan - literal) < 1e-9);

  probe.invalidateRecall();
  let threw = false;
  let results = null;
  try {
    results = await recall('那部电影没看完', { scorer: boom, limit: 3 });
  } catch (err) {
    threw = true;
    console.log('    抛了：', err.message);
  }
  ok('recall 不抛错，正常返回数组', !threw && Array.isArray(results), threw ? 'threw' : `${results.length} 条`);
  ok('坏 scorer 下仍拿得到字面命中', results.length > 0 && results[0].hit > 0, results.length ? `hit=${results[0].hit}` : '空');
  ok('字符串 scorer 名字走查表', pickScorerSmoke(recall));

  function pickScorerSmoke() {
    try {
      const v = probe.scoreEntry(q, view, probe.pickScorer('semantic'));
      return v > 0;
    } catch (err) {
      return false;
    }
  }
}

console.log(`\n======== pass ${pass} / fail ${fail} ========`);
if (fail) process.exitCode = 1;

// ── 探针构造 ──────────────────────────────────────────────────
async function loadRecallProbe() {
  const src = readFileSync(new URL('../app/web/src/app/core/chat/recall.js', import.meta.url), 'utf8');
  const patched = src
    .replace(
      /^import \{ openDb, STORE_HEADS, STORE_REVISIONS \}.*$/m,
      "const openDb = () => Promise.reject(new Error('node 里没有 IndexedDB'));\nconst STORE_HEADS = 'data-heads';\nconst STORE_REVISIONS = 'data-revisions';",
    )
    .replace(
      /^import \{ listLatest \}.*$/m,
      'const listLatest = (kind) => Promise.resolve((globalThis.__RECALL_FAKE__ || {}).byKind && globalThis.__RECALL_FAKE__.byKind[kind] ? globalThis.__RECALL_FAKE__.byKind[kind] : []);',
    );
  const dir = fileURLToPath(new URL('./_tmp/', import.meta.url));
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `recall-probe-${process.pid}.mjs`);
  writeFileSync(out, patched, 'utf8');
  return import(pathToFileURL(out).href);
}
