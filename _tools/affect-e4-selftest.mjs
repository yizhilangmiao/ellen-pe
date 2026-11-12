// E4 接线自测：不用浏览器、不发网络请求，node 直接跑。
//
//   E:\ailian\工具\node\node-v24.21.0-win-x64\node.exe _tools\affect-e4-selftest.mjs
//
// 覆盖四件必须证明的事：
//   ① 注入块真的拼进了 system prompt（base + [此刻] + 写法约束，且 ≤220 汉字）
//   ② 语气随档位变，四档各自可关、关掉高档退回下一档、全关退回旧行为（不加约束）
//   ③ 长度/姿态只在一处算：fatigue>60 变短、affection<30 变客气
//   ④ 事件分类全走本地关键词表（不为消息多花请求）：「算了吧」「我不想说了」「你走吧」都要命中；
//      安全词先判且不封顶；表情按好感分 SAFE / ECHO 两组
import {
  DAILY,
  effectiveDesire,
  loadAffect,
  normalizeState,
  saveAffect,
} from '../app/web/src/app/core/affect.js';
import {
  INJECTION_MAX_HAN,
  applyUtterance,
  attachToPrompt,
  classify,
  countHan,
  renderInjection,
} from '../app/web/src/app/core/affect-events.js';
import {
  TONE_TIERS,
  resolveToneTier,
  styleOf,
  toneLineOf,
  toneTierIdOf,
} from '../app/web/src/app/core/tone.js';
// sticker-reply.js 里有 import.meta.glob（Vite 专属），node 直接 import 会炸。
// 所以现场复制一份、把那行换成假的收藏表再导 —— 测的是我们自己的分池逻辑，不是素材。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

async function loadStickerModule() {
  const src = readFileSync(new URL('../app/web/src/app/core/sticker-reply.js', import.meta.url), 'utf8');
  const stub = `
const STICKER_FAVORITES = [
  { id: 'f1', file: 'f1.webp', slot: '比心', label: '比心' },
  { id: 'f2', file: 'f2.webp', slot: '晚安', label: '晚安' },
  { id: 'f3', file: 'f3.webp', slot: '笔芯', label: '笔芯' },
  { id: 'f4', file: 'f4.webp', slot: '生气', label: '生气' },
  { id: 'f5', file: 'f5.webp', slot: '无语', label: '无语' },
  { id: 'f6', file: 'f6.webp', slot: '摆烂', label: '摆烂' },
];
const stickerById = (id) => STICKER_FAVORITES.find((f) => f.id === id) || null;
const pickCustomForSlot = () => null;
`;
  // 两条 import 都要换掉：assets/stickers.js 带 import.meta.glob（Vite 专属），
  // sticker-library.js 是 IndexedDB 读文件表（node 里没有库）——
  // 测的是我们自己的分池逻辑，素材/存储一律打桩。
  const patched = src
    .replace(/^import .*assets\/stickers\.js.*$/m, stub)
    .replace(/^import .*sticker-library\.js.*$/m, '');
  // 临时文件落项目内 _tools/_tmp（C 盘 %TEMP% 在这个环境写不进去）
  const dir = fileURLToPath(new URL('./_tmp/', import.meta.url));
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `sticker-probe-${process.pid}.mjs`);
  writeFileSync(out, patched, 'utf8');
  return import(pathToFileURL(out).href);
}

const { ECHO_SLOTS, SAFE_SLOTS, pickStickerReply, poolKindOf } = await loadStickerModule();

let pass = 0;
const fails = [];
function ok(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    return;
  }
  fails.push(`${name}${extra ? ` · ${extra}` : ''}`);
  console.log(`FAIL ${name}${extra ? ` · ${extra}` : ''}`);
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}

const NOW = new Date('2026-11-13T20:00:00+08:00').getTime();
const withDims = (patch) => {
  const st = normalizeState(null, NOW);
  Object.assign(st.dims, patch);
  return st;
};

// —— ① 注入块拼进 prompt ——
{
  const st = withDims({ lust: 88, resist: 18, affection: 62, fatigue: 30 });
  const base = '你是艾莲。你和老大在一起，是恋人关系。';
  const styleLine = [toneLineOf(st.dims, { direct: true, ask: true, hint: true, inner: true }), styleOf(st.dims).line]
    .filter(Boolean)
    .join('\n');
  const prompt = attachToPrompt(base, st, { styleLine });

  ok('prompt 保留人格提示', prompt.startsWith(base));
  ok('prompt 含注入块标记', prompt.includes('[此刻]'));
  ok('prompt 含写法约束', prompt.includes('写法：2~4 句'));
  ok('prompt 含语气约束', prompt.includes('语气：'));
  ok('prompt 含长度约束', prompt.includes('回复长度：'));
  ok('注入块本身 ≤220 汉字', countHan(renderInjection(st, { now: NOW })) <= INJECTION_MAX_HAN);
  const order = [prompt.indexOf(base), prompt.indexOf('[此刻]'), prompt.indexOf('语气：'), prompt.indexOf('回复长度：')];
  ok('顺序：人格 → 处境 → 语气 → 长度', order[0] === 0 && order.every((v, i) => (i === 0 ? v === 0 : v > order[i - 1])), order.join(','));
  console.log('[1] prompt 尾部 3 行：');
  console.log(prompt.split('\n').slice(-3).map((l) => `    ${l}`).join('\n'));
}

// —— ② 语气随档位变 + 四档开关 ——
{
  const cases = [
    { name: 'inner', dims: { lust: 20, resist: 60, affection: 40 } },
    { name: 'hint', dims: { lust: 70, resist: 20, affection: 40 } },
    { name: 'ask', dims: { lust: 80, resist: 15, affection: 40 } },
    { name: 'direct', dims: { lust: 95, resist: 10, affection: 60 } },
  ];
  const seen = [];
  for (const c of cases) {
    const st = withDims(c.dims);
    const tier = toneTierIdOf(st.dims);
    eq(`档位 ${c.name}`, tier, c.name);
    const line = toneLineOf(st.dims, { direct: true, ask: true, hint: true, inner: true });
    ok(`语气句非空 ${c.name}`, line.length > 0);
    seen.push(line);
  }
  eq('四档语气句各不相同', new Set(seen).size, 4);

  const hi = withDims({ lust: 95, resist: 10, affection: 60 });
  eq('关掉 direct → 退回 ask', resolveToneTier(effectiveDesire(hi.dims), { direct: false, ask: true, hint: true, inner: true }).id, 'ask');
  eq(
    '连续关两档 → 继续下退',
    resolveToneTier(effectiveDesire(hi.dims), { direct: false, ask: false, hint: true, inner: true }).id,
    'hint'
  );
  eq(
    '四档全关 → null（不加语气约束，不是沉默）',
    resolveToneTier(effectiveDesire(hi.dims), { direct: false, ask: false, hint: false, inner: false }),
    null
  );
  eq('四档全关时语气句为空串', toneLineOf(hi.dims, { direct: false, ask: false, hint: false, inner: false }), '');
  ok(
    '语气词都在现有朗读表里（轻声/笑着/撒娇/急促）',
    TONE_TIERS.every((t) => ['轻声', '笑着', '撒娇', '急促'].includes(t.tone)),
    TONE_TIERS.map((t) => t.tone).join('/')
  );
}

// —— ③ 长度/姿态只在一处算 ——
{
  const normal = styleOf({ fatigue: 20, affection: 45 });
  const tired = styleOf({ fatigue: 72, affection: 45 });
  const cold = styleOf({ fatigue: 20, affection: 22 });
  const tiredCold = styleOf({ fatigue: 80, affection: 10 });
  eq('平常 → normal', normal.length, 'normal');
  eq('累了 → short', tired.length, 'short');
  ok('累了的约束提到句子短', tired.line.includes('短'));
  eq('好感低 → polite', cold.length, 'polite');
  ok('客气的约束提到问一句答一句', cold.line.includes('问一句答一句'));
  eq('又累又冷 → 客气优先', tiredCold.length, 'polite');
  ok('长度约束只有一句（不叠加两套规则）', tiredCold.line.split('；').length <= 2, tiredCold.line);
  console.log('[3] 长度约束：');
  console.log(`    平常 ${normal.line}`);
  console.log(`    累   ${tired.line}`);
  console.log(`    心冷 ${cold.line}`);
}

// —— ④ 事件分类：本地关键词表，不花请求 ——
{
  const must = [
    ['你走吧', 'leave'],
    ['我不想说了', 'ignore'],
    ['算了吧', 'ignore'],
    ['随便吧', 'ignore'],
    ['你是不是骗我了', 'lie'],
    ['闭嘴吧你', 'scold'],
    ['你今天真好看', 'praise'],
    ['对不起，我错了', 'apologize'],
    ['给你买了个礼物', 'gift'],
    ['我有点想你了', ''],
  ];
  for (const [text, want] of must) {
    const hit = classify(text);
    eq(`分类「${text}」`, hit.type, want);
    eq(`分类「${text}」不是安全词`, hit.safeWord, false);
  }

  // 安全词先判，且必须排掉「别停」这种反向说法
  ok('「安全词」命中', classify('安全词').safeWord);
  ok('「停」命中', classify('停').safeWord);
  ok('「停下」命中', classify('停下').safeWord);
  ok('「别停」不算安全词', !classify('别停').safeWord);
  ok('「不要停」不算安全词', !classify('不要停').safeWord);

  // 安全词不封顶：lust 95 → 65（不是 −6）
  const st = withDims({ lust: 95, resist: 10, affection: 50 });
  const res = applyUtterance(st, '安全词', { now: NOW });
  ok('安全词标记', res.safeWord === true);
  ok('安全词性欲 −30（不封顶）', Math.abs(st.dims.lust - 65) < 0.51, `lust=${st.dims.lust}`);
  ok('安全词暂停 30 分钟', st.pausedUntil - NOW === 30 * 60e3, `paused=${(st.pausedUntil - NOW) / 60000}min`);

  // 没命中也算「在场」：推进 lastEventAt，不然一直被当成晾着
  const st2 = withDims({});
  st2.lastEventAt = NOW - 3600 * 1000;
  applyUtterance(st2, '我有点想你了', { now: NOW });
  eq('未命中也推进 lastEventAt', st2.lastEventAt, NOW);

  // 单次封顶 ±6：凶十句不会一次打穿好感
  const st3 = withDims({ affection: 60 });
  applyUtterance(st3, '闭嘴吧你', { now: NOW });
  ok('scold 单次封顶 ≤6', 60 - st3.dims.affection <= 6.001, `drop=${60 - st3.dims.affection}`);
}

// —— ⑤ 表情按好感分池 ——
{
  const warm = pickStickerReply({ incomingSlot: '生气', roll: 0, pick: 0.9, affection: 80 });
  ok('好感 80 → SAFE 池', warm && SAFE_SLOTS.includes(warm.slot), warm && warm.slot);
  const cold = pickStickerReply({ incomingSlot: '问号', roll: 0, pick: 0.9, affection: 12 });
  ok('好感 12 → ECHO 池', cold && ECHO_SLOTS.includes(cold.slot), cold && cold.slot);
  eq('poolKindOf(80)', poolKindOf(80), 'safe');
  eq('poolKindOf(12)', poolKindOf(12), 'echo');
  eq('poolKindOf(40)', poolKindOf(40), 'mixed');
  const legacy = pickStickerReply({ roll: 0, pick: 0.5 });
  ok('不传好感 = 旧行为（照旧回一张）', !!legacy);
}

// —— ⑥ 落盘只存两位小数、重启后接着走 ——
{
  const mem = new Map();
  const store = {
    getMeta: async (k, d) => (mem.has(k) ? mem.get(k) : d),
    putMeta: async (k, v) => {
      mem.set(k, v);
    },
  };
  const st = withDims({ lust: 30.2567, fatigue: 21.111, affection: 40.4444 });
  await saveAffect({ store, state: st });
  const raw = mem.get('mood-v1');
  const text = JSON.stringify(raw);
  ok('落盘保留两位小数', /"lust":30\.26/.test(text) || /"lust":30\.26,/.test(text), text.slice(0, 80));
  const back = await loadAffect({ store, now: NOW + 1000, persist: false });
  ok('读回后仍是浮点（没被取整成整数）', Number.isFinite(back.dims.lust));
  ok('读回值与日常值同量级', Math.abs(back.dims.lust - DAILY.lust) < 5, `lust=${back.dims.lust}`);
}

// —— ⑦ 端到端：一句话改状态 → 下一轮 prompt 真的变了 ——
{
  const mem = new Map();
  const store = {
    getMeta: async (k, d) => (mem.has(k) ? mem.get(k) : d),
    putMeta: async (k, v) => {
      mem.set(k, v);
    },
  };
  const prefs = { direct: true, ask: true, hint: true, inner: true };
  const NL = String.fromCharCode(10);
  const build = (st) =>
    attachToPrompt('你是艾莲。', st, {
      styleLine: [toneLineOf(st.dims, prefs), styleOf(st.dims).line].filter(Boolean).join(NL),
    });

  const st = normalizeState(null, NOW);
  const before = build(st);
  ok('起点 prompt 里有处境块', before.includes('[此刻]'));

  // 连着 8 句难听的：好感被打下去，她该变客气、心冷
  const nasty = ['闭嘴吧你', '算了吧', '随便吧', '你走吧', '我骗你了', '就这样吧', '我不想说了', '烦不烦'];
  let t = NOW;
  for (const line of nasty) {
    t += 20 * 60 * 1000;
    const state = await loadAffect({ store, now: t, persist: false });
    applyUtterance(state, line, { now: t });
    await saveAffect({ store, state });
  }
  const st2 = await loadAffect({ store, now: t, persist: false });
  const after = build(st2);
  ok('挨完骂好感落到 30 以下', st2.dims.affection < 30, `affection=${st2.dims.affection}`);
  ok('挨完骂 prompt 变成「客气」', after.includes('客气'), after.split(NL).pop());
  ok('挨完骂 prompt 与起点不同', after !== before);
  console.log('[7] 挨骂后 prompt 尾部：');
  console.log(after.split(NL).slice(-2).map((l) => `    ${l}`).join(NL));
}


// —— ⑧ 嘴上硬 & 主动消息门槛 ——
{
  const st = normalizeState({ dims: { lust: 65, resist: 70, affection: 60, fatigue: 20, lewd: 45, possess: 55, shame: 55 } }, NOW);
  const text = renderInjection(st, { now: NOW });
  const NL2 = String.fromCharCode(10);
  ok('理智高+性欲高 → 注入块里有「嘴上说得硬」', text.includes('嘴上说得硬'), text.split(NL2)[0]);
  ok('嘴上硬不算「心冷」', !text.includes('心里是远的'));

  // 主动消息门槛：文档 eff<45 不开口。把日常值和「真想要」两个点都量出来，
  // 免得只看代码以为门槛很低（实测日常只有个位数，见汇报）。
  const daily = effectiveDesire({ ...DAILY });
  const keen = effectiveDesire({ ...DAILY, lust: 80, resist: 30 });
  ok('日常状态 eff < 45（不主动开口）', daily < 45, `eff=${daily.toFixed(2)}`);
  ok('真想要时 eff > 45（会开口）', keen > 45, `eff=${keen.toFixed(2)}`);
  console.log(`[8] 平常 eff=${daily.toFixed(2)}（不开口） / lust80+resist30 eff=${keen.toFixed(2)}（开口）`);
}

console.log(`\n${pass} pass, ${fails.length} fail`);
if (fails.length) {
  console.log('失败项：');
  for (const f of fails) console.log(`  - ${f}`);
  process.exitCode = 1;
}
