// E1/E2/E3 的脱机验收（不需要浏览器、不需要 IndexedDB、不碰真机）。
//
// 跑法： E:\ailian\工具\node\node-v24.21.0-win-x64\node.exe _tools\affect-selftest.mjs
//
// 为什么不用原生 require：core 里的模块是纯 ESM，而且 meta 读写必须能换成内存 Map ——
// 直接用 records.js 会去开 IndexedDB，node 里没有那东西，测的就不是逻辑而是环境。
import { normalizeState, settle, serialize, loadAffect, saveAffect, DIMS, DAILY, effectiveDesire, bandOf, awakeMsBetween, derivedMood } from '../app/web/src/app/core/affect.js';
import {
  EVENTS,
  applyEvent,
  applySafeWord,
  applyNeglect,
  renderInjection,
  countHan,
  sameKindScale,
  activeGrudges,
  INJECTION_MAX_HAN,
  NEGLECT_HOURS,
} from '../app/web/src/app/core/affect-events.js';

const HOUR = 3600e3;
const DAY = 86400000;

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

/** 内存版 meta 存储（形状与 records.js 一致：getMeta(key, fallback) / putMeta(key, value)）。 */
function memStore() {
  const map = new Map();
  return {
    map,
    async getMeta(key, fallback = null) {
      return map.has(key) ? map.get(key) : fallback;
    },
    async putMeta(key, value) {
      map.set(key, value);
    },
  };
}

// 固定起点：2026-11-13 14:00 本地时间（避开 22:00–08:00 的睡前/睡眠窗，测试少一点时段噪声）
const T0 = new Date(2026, 10, 13, 14, 0, 0).getTime();

function stateAt(at = T0, dims = null) {
  const st = normalizeState(null, at);
  st.lastSettle = at;
  if (dims) Object.assign(st.dims, dims);
  return st;
}

// —— ① 拨 24h：数值确实回落，但停在日常值 ——
head('① 24 小时回落且不穿日常值');
{
  const st = stateAt(T0, { lewd: 75, affection: 70, fatigue: 60, possess: 65 });
  const before = { ...st.dims };
  settle(st, T0 + 24 * HOUR);
  for (const dim of ['lewd', 'affection', 'fatigue', 'possess']) {
    const v = st.dims[dim];
    ok(
      `${dim} 回落且不低于日常值`,
      v < before[dim] && v >= DAILY[dim] - 0.2,
      `${before[dim].toFixed(2)} → ${v.toFixed(2)}（日常 ${DAILY[dim]}）`
    );
  }
}

// —— ①b 连续多天：一切收敛回日常值（时间永远推不到 0，也推不到日常值以下） ——
head('①b 二十天后收敛到日常值');
{
  const st = stateAt(T0, { lust: 95, lewd: 92, possess: 90, shame: 95, resist: 92, fatigue: 80, affection: 95 });
  let now = T0;
  for (let i = 0; i < 10; i += 1) {
    now += 48 * HOUR; // 每次 48h，正好顶到回溯上限
    settle(st, now);
  }
  // affection 半衰期 72h，要 ±2 得跑过 5 个半衰期（约 15 天），所以这里跑到 20 天
  // 疲劳除外：睡前每小时 +2.5 每天都加回来，稳态天生比日常值高一点（约 +2.3），这是设计不是残留
  const measured = DIMS.filter((d) => d !== 'fatigue');
  const off = measured.map((d) => Math.abs(st.dims[d] - DAILY[d]));
  const worst = Math.max(...off);
  ok('七维（除疲劳）都回到日常值 ±2 以内', worst <= 2, `最大偏离 ${worst.toFixed(2)}，dims=${JSON.stringify(roundDims(st.dims))}`);
  ok('没有一维掉到日常值以下', DIMS.every((d) => st.dims[d] >= DAILY[d] - 2), JSON.stringify(roundDims(st.dims)));
  // 疲劳是例外：睡前每小时 +2.5 是每天都会加回来的，稳态本来就在日常值之上
  ok('疲劳稳态不超过日常值 +5', st.dims.fatigue < DAILY.fatigue + 5, `fatigue=${st.dims.fatigue.toFixed(2)}`);
}
function roundDims(dims) {
  const out = {};
  for (const d of DIMS) out[d] = Number(dims[d].toFixed(2));
  return out;
}

// —— ①c 日常状态的派生情绪：不能把「每天」说成「在忍着」 ——
head('①c 日常状态的派生情绪（给 companion.js 的 {mood, note}）');
{
  const st = stateAt(T0);
  const m = derivedMood(st);
  // 日常 resist 50 / lust 30 天然差 20，阈值定低了就会天天「在忍着」，这句就贬值了
  ok('日常值是「淡淡的」而不是「在忍着」', m.mood === '淡淡的', `${m.mood} —— ${m.note}`);
  ok('形状还是 {mood, note}', typeof m.mood === 'string' && typeof m.note === 'string' && m.mood.length >= 2 && m.mood.length <= 4, `mood=${m.mood}`);
  const hot = stateAt(T0, { lust: 95, resist: 5, affection: 95 });
  ok('高欲望时 mood 跟着变', derivedMood(hot).mood !== m.mood, derivedMood(hot).mood);
}

// —— ② 连跑 120 次结算不停摆（浮点残差能攒起来，不许被取整抹平） ——
head('② 120 × 30 秒结算：浮点残差必须攒得住');
{
  const st = stateAt(T0, { lust: 90 });
  let now = T0;
  for (let i = 0; i < 120; i += 1) {
    now += 30e3;
    settle(st, now);
  }
  // 90 → 一个小时 −3/h ≈ 87
  ok('一小时漂移落地（≈87）', st.dims.lust > 86.5 && st.dims.lust < 87.5, `lust=${st.dims.lust.toFixed(4)}`);
  ok('不是被取整冻住', st.dims.lust < 89.9, `lust=${st.dims.lust.toFixed(4)}`);

  // 关键一条：起点故意带小数（33.05），每片只掉 0.025。
  // 如果哪里偷偷 Math.round 了，第一片 33.025 → 33，之后永远卡在 33 —— 数值再也不会动。
  const fs = stateAt(T0, { lust: 33.05 });
  let fnow = T0;
  for (let i = 0; i < 120; i += 1) {
    fnow += 30e3;
    settle(fs, fnow);
  }
  ok('带小数起点也能挪动（33.05 → 30.05）', Math.abs(fs.dims.lust - 30.05) < 0.02, `lust=${fs.dims.lust.toFixed(6)}`);
  ok('没被取整冻在原地', fs.dims.lust < 32.9, `lust=${fs.dims.lust.toFixed(6)}`);
  ok('落盘才取两位', Object.values(serialize(fs).dims).every((v) => Math.round(v * 100) === Number((v * 100).toFixed(6))));
  ok('内存保持浮点（serialize 不改原值）', fs.dims.lust !== serialize(fs).dims.lust);
}

// —— ③ 连夸五句：好感只涨一点点（同类递减 1/(1+n)） ——
head('③ 连夸五句的增益');
{
  const st = stateAt(T0);
  const start = st.dims.affection;
  let at = T0;
  for (let i = 0; i < 5; i += 1) {
    at += 20e3; // 五句都在一小时内
    applyEvent(st, { type: 'praise', at });
  }
  const gain = st.dims.affection - start;
  // 文档验收写「3.8 左右」，按 1/(1+n) 逐条递减实际是 2+1+0.67+0.5+0.4≈4.57；
  // 这里给一个带宽并打印实测值，别把文档的估计值当成硬断言（口径差异见交付说明）。
  ok('五句好感增益在 3.5–4.8 之间', gain >= 3.5 && gain <= 4.8, `实测 +${gain.toFixed(3)}（文档估 3.8，公式给 4.567）`);
  ok('第一条不打折、后面递减', Math.abs(sameKindScale(stateAt(T0), 'praise', T0) - 1) < 1e-9);
  const st2 = stateAt(T0);
  applyEvent(st2, { type: 'praise', at: T0 });
  ok('第二条系数 1/2', Math.abs(sameKindScale(st2, 'praise', T0 + 1) - 0.5) < 1e-9);
}

// —— ③b 单次封顶 ±6：说要走 好感 −8 只落地 −6，且压 3 天余怨 ——
head('③b 单次封顶与余怨');
{
  const st = stateAt(T0, { affection: 60 });
  const r = applyEvent(st, { type: 'leave', at: T0 + 1000 });
  ok('好感 −8 被夹到 −6', Math.abs(st.dims.affection - 54) < 1e-9, `affection=${st.dims.affection.toFixed(2)}`);
  const g = activeGrudges(st, T0 + 1000)[0];
  ok('余怨压三天', !!g && g.kind === 'leave' && g.until - g.at === 3 * DAY, g ? `${g.kind} until=+${(g.until - g.at) / DAY}d` : '无');
  ok('余怨在三天内仍有效', activeGrudges(st, T0 + 1000 + 3 * DAY - 1000).length === 1);
  ok('四天后自然过期', activeGrudges(st, T0 + 1000 + 3 * DAY + 1000).length === 0);
  const inj = renderInjection(st, { now: T0 + 1000 + 26 * HOUR });
  ok('注入块念得出「昨天那句要走」', /要走/.test(inj) && /昨天/.test(inj), inj.split('\n')[0]);
  ok('事后不封顶（lust −25 真落地）', (() => {
    const s2 = stateAt(T0, { lust: 90 });
    applyEvent(s2, { type: 'aftercare', at: T0 + 5 });
    return Math.abs(s2.dims.lust - 65) < 1e-9;
  })());
}

// —— ④ 安全词：不封顶、性欲 −30、停 30 分钟 ——
head('④ 安全词');
{
  const st = stateAt(T0, { lust: 95 });
  const r = applySafeWord(st, { at: T0 });
  ok('性欲 −30（不封顶）', Math.abs(st.dims.lust - 65) < 1e-9, `lust=${st.dims.lust}`);
  ok('暂停 30 分钟', Math.abs(st.pausedUntil - (T0 + 30 * 60e3)) < 1e-9);
  const skipped = applyEvent(st, { type: 'praise', at: T0 + 10 * 60e3 });
  ok('暂停期内事件不生效', skipped.skipped === 'paused', JSON.stringify(skipped));
  const resumed = applyEvent(st, { type: 'praise', at: T0 + 31 * 60e3 });
  ok('暂停过后恢复', !resumed.skipped, `${resumed.type} scale=${resumed.scale}`);
  const inj = renderInjection(st, { now: T0 + 60e3 });
  ok('暂停时注入块说的是「先缓一缓」', /缓一缓/.test(inj), inj.split('\n')[0]);
}

// —— ④b 第一次：各只触发一次 ——
head('④b 第一次');
{
  const st = stateAt(T0, { lust: 70, lewd: 70, affection: 60 });
  const a = applyEvent(st, { type: 'intimate', at: T0 + 1 });
  const b = applyEvent(st, { type: 'intimate', at: T0 + 2 });
  ok('第一次被碰只记一次', a.first === 'touch' && b.first === null, `a=${a.first} b=${b.first}`);
  const inj = renderInjection(st, { now: T0 + 2 * HOUR });
  ok('24h 内带专属语气', /第一次被你碰到/.test(inj), inj.split('\n')[0]);
  const later = renderInjection(st, { now: T0 + 26 * HOUR });
  ok('24h 后专属语气消失', !/第一次被你碰到/.test(later));
}

// —— ④c 被晾着：清醒时长 > 6h，睡眠窗不算 ——
head('④c 被晾着');
{
  ok('整段 23:30–08:00 的清醒时长是 0', awakeMsBetween(new Date(2026, 10, 12, 23, 30).getTime(), new Date(2026, 10, 13, 8, 0).getTime()) === 0);
  // 22:00 → 次日 09:00 共 11h，其中 23:30–08:00 睡眠 8.5h 不算 → 清醒 22:00–23:30 与 08:00–09:00 合计 2.5h
  ok('22:00–次日 09:00 只算 2.5 小时', Math.abs(awakeMsBetween(new Date(2026, 10, 13, 22, 0).getTime(), new Date(2026, 10, 14, 9, 0).getTime()) / HOUR - 2.5) < 1e-9, `${(awakeMsBetween(new Date(2026, 10, 13, 22, 0).getTime(), new Date(2026, 10, 14, 9, 0).getTime()) / HOUR).toFixed(2)}h`);

  const st = stateAt(T0);
  st.lastEventAt = new Date(2026, 10, 13, 22, 0).getTime();
  // 次日 03:00：整段落在睡眠窗里 → 不算冷落
  const night = applyNeglect(st, { now: new Date(2026, 10, 14, 3, 0).getTime() });
  ok('凌晨三点的沉默不算冷落', night.neglected === false && night.applied === false, `awake=${night.awakeHours.toFixed(2)}h`);
  // 次日 15:00：清醒 08:00–15:00 = 7h → 算冷落，扣一次
  const affectionBefore = st.dims.affection;
  const day = applyNeglect(st, { now: new Date(2026, 10, 14, 15, 0).getTime() });
  ok('中午该扣一次', day.applied === true && st.dims.affection < affectionBefore, `affection ${affectionBefore} → ${st.dims.affection.toFixed(2)}（阈 ${NEGLECT_HOURS}h）`);
  const again = applyNeglect(st, { now: new Date(2026, 10, 14, 16, 0).getTime() });
  ok('同一段沉默只记一次失望', again.applied === false && again.already === true);
  ok('晾着不动 lastEventAt（计时器不被重置）', st.lastEventAt === new Date(2026, 10, 13, 22, 0).getTime());
}

// —— ⑤ 注入块：任何状态都非空、≤220 汉字、档位语句不同 ——
head('⑤ 注入块');
{
  const cases = [
    ['全日常', null],
    ['全 0', Object.fromEntries(DIMS.map((d) => [d, 0]))],
    ['全 100', Object.fromEntries(DIMS.map((d) => [d, 100]))],
    ['三种冷', { lust: 10, lewd: 10, affection: 10, resist: 70, fatigue: 30, possess: 40, shame: 40 }],
    ['只想被抱', { lust: 12, lewd: 40, affection: 65, resist: 40, fatigue: 85, possess: 40, shame: 40 }],
    ['吃醋', { lust: 50, lewd: 50, affection: 70, resist: 40, fatigue: 20, possess: 92, shame: 60 }],
    ['憋着', { lust: 88, lewd: 60, affection: 55, resist: 80, fatigue: 20, possess: 60, shame: 75 }],
  ];
  for (const [name, dims] of cases) {
    const st = stateAt(T0, dims);
    const text = renderInjection(st, { now: T0 });
    const han = countHan(text);
    ok(`「${name}」非空`, text.trim().length > 0, `${han} 汉字`);
    ok(`「${name}」≤ ${INJECTION_MAX_HAN} 汉字`, han <= INJECTION_MAX_HAN, `${han}`);
    ok(`「${name}」以 [此刻] 开头且有句号`, /^\[此刻\]/.test(text) && /。/.test(text));
    ok(`「${name}」带写法约束`, /写法：2~4 句/.test(text));
    const sentences = text.split('\n')[0].split('。').filter((x) => x.trim().length > 0).length;
    ok(`「${name}」处境 2–4 句`, sentences >= 2 && sentences <= 4, `${sentences} 句`);
  }

  // 五档语句必须不同，而且每个用例必须真的落在预期档里
  // （第一版取的值全挤在低档，只验出「有 5 种文本」，其中两种都是「心里想」，等于没验）
  const bandCases = [
    ['direct', { lust: 95, resist: 10, affection: 95 }], // 90 × 0.98 = 88.2
    ['approach', { lust: 95, resist: 10, affection: 60 }], // 90 × 0.84 = 75.6
    ['ask', { lust: 80, resist: 15, affection: 55 }], // 72.5 × 0.82 = 59.5
    ['hint', { lust: 70, resist: 20, affection: 50 }], // 60 × 0.80 = 48
    ['inner', { lust: 50, resist: 30, affection: 40 }], // 35 × 0.76 = 26.6
  ];
  const bandTexts = new Set();
  const hitBands = [];
  for (const [want, dims] of bandCases) {
    const st = stateAt(T0, { lewd: 60, fatigue: 20, possess: 50, shame: 40, ...dims });
    const eff = effectiveDesire(st.dims);
    const band = bandOf(eff);
    hitBands.push(band.id);
    const t = renderInjection(st, { now: T0 }).split('\n')[0];
    bandTexts.add(t);
    ok(`用例命中「${want}」档`, band.id === want, `eff=${eff.toFixed(1)} 档=${band.label}`);
    console.log(`      eff=${eff.toFixed(1)} 档=${band.label} → ${t}`);
  }
  ok('五档各命中一次', new Set(hitBands).size === 5, hitBands.join(','));
  ok('五档给出五种不同语句', bandTexts.size === 5, `${bandTexts.size} 种`);
}

// —— ⑥ 落盘形状 + 读时结算（用内存 store 走完整一条链路） ——
head('⑥ 落盘与读时结算');
{
  const store = memStore();
  const st = await loadAffect({ store, now: T0 });
  ok('首次读给出日常值', DIMS.every((d) => Math.abs(st.dims[d] - DAILY[d]) < 1e-9), JSON.stringify(roundDims(st.dims)));
  ok('首次读就落盘', store.map.has('mood-v1'));
  st.dims.lust = 80;
  st.lastSettle = T0;
  await saveAffect({ store, state: st });
  const saved = store.map.get('mood-v1');
  ok('落盘形状齐五个必需字段', ['dims', 'grudges', 'firsts', 'lastSettle', 'lastEventAt'].every((k) => k in saved), Object.keys(saved).join(','));
  ok('落盘保留两位小数', Object.values(saved.dims).every((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-9));
  const back = await loadAffect({ store, now: T0 + 2 * HOUR });
  ok('再读时把两小时补算了', back.dims.lust < 80 && back.dims.lust > 73, `lust=${back.dims.lust.toFixed(3)}`);
}

// —— ⑦ 事件表完整性 ——
head('⑦ 事件表');
{
  const keys = Object.keys(EVENTS);
  ok('22 条事件', keys.length === 22, `${keys.length} 条`);
  ok('好话 11 / 坏话 11', keys.filter((k) => EVENTS[k].side === 'good').length === 11 && keys.filter((k) => EVENTS[k].side === 'bad').length === 11);
  ok('每条都有中文名', keys.every((k) => typeof EVENTS[k].label === 'string' && EVENTS[k].label.length > 0));
  ok('每条至少动一维', keys.every((k) => Object.keys(EVENTS[k].delta).length > 0));
  ok('维度名都在七维里', keys.every((k) => Object.keys(EVENTS[k].delta).every((d) => DIMS.includes(d))));
}

// —— ⑧ 随机扫：200 个随机状态，注入块必须永远非空、≤220、2–4 句 ——
// 前面七个用例是手挑的，容易只覆盖「好看的」组合；这一轮专门撞极端值。
head('⑧ 随机状态扫注入块（200 个）');
{
  let seed = 20261113;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  let empty = 0;
  let oversized = 0;
  let badShape = 0;
  let worst = 0;
  for (let i = 0; i < 200; i += 1) {
    const dims = Object.fromEntries(DIMS.map((d) => [d, Math.round(rnd() * 1000) / 10]));
    const st = stateAt(T0, dims);
    // 一半带余怨，一半带暂停，把附注分支也扫到
    if (i % 3 === 0) st.grudges = [{ kind: 'leave', at: T0 - DAY, until: T0 + 2 * DAY }];
    if (i % 5 === 0) st.pausedUntil = T0 + 10 * 60e3;
    if (i % 7 === 0) st.firsts = { touch: T0 - HOUR };
    const text = renderInjection(st, { now: T0 });
    const han = countHan(text);
    if (han > worst) worst = han;
    if (!text.trim()) empty += 1;
    if (han > INJECTION_MAX_HAN) oversized += 1;
    const lines = text.split('\n');
    const n = lines[0].split('。').filter((x) => x.trim().length > 0).length;
    if (n < 2 || n > 4) badShape += 1;
  }
  ok('200 个状态没有一个是空串', empty === 0, `空 ${empty}`);
  ok('200 个状态都没超 220 汉字', oversized === 0, `超长 ${oversized}，最长 ${worst}`);
  ok('200 个状态都是 2–4 句', badShape === 0, `形状不对 ${badShape}`);
}

console.log(`\n======== ${fail === 0 ? '全部通过' : '有失败'}：pass ${pass} / fail ${fail} ========`);
process.exit(fail === 0 ? 0 : 1);
