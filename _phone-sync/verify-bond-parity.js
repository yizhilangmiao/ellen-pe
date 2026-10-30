/* 等价性验证：手机版注入模块里的 replay() 必须和电脑版 Bond.record() 逐步等价。
 * 电脑版：memory/src/bond.cjs（已 22 项测试全绿）
 * 手机版：_phone-sync/inject-letter.js 里的 replay()
 * 只比点数 / 阶段 / 阶段内条数 / 信匣阶段序列。
 *
 * 跑：& 'E:\ailian\工具\node\node-v24.21.0-win-x64\node.exe' _phone-sync\verify-bond-parity.js
 * 换路径：--app <电脑版 resources\app>  --phone <注入模块.js>
 */
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

function arg(name, fallback) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const APP = arg("app", "E:/ailian/艾莲电脑版/创作版/resources/app");
const { Bond } = require(path.join(APP, "memory/src/bond.cjs"));
const PHONE = arg("phone", path.join(__dirname, "inject-letter.js"));

const src = fs.readFileSync(PHONE, "utf8");

function cut(from, to) {
  const i = src.indexOf(from);
  const j = src.indexOf(to, i);
  if (i < 0 || j < 0) throw new Error("切段失败: " + from + " / " + to);
  return src.slice(i, j);
}

const consts = cut("var ORDER = ", "/* ------------------------------------------------ 存储 */");
const replaySrc = cut("function replay(rows) {", "  function clip(");

const factory = new Function(
  consts + "\n" + replaySrc + "\nreturn { replay: replay, ORDER: ORDER };"
);
const { replay, ORDER } = factory();

function desktop(seq) {
  const db = new DatabaseSync(":memory:");
  let now = "2026-01-01T09:00:00.000Z";
  const bond = new Bond(db, { characterId: "ellen", clock: () => now });
  bond.initialize();
  let out = null;
  for (const m of seq) {
    out = bond.record({ role: m.role, occurredAt: m.createdAt });
  }
  const st = bond.state();
  const letters = bond.listLetters();
  db.close();
  return {
    points: st.points,
    stage: st.stage,
    stageMessages: st.stageMessages,
    promotions: (out ? out.promotions : []).map((p) => p.to),
    letters: letters.map((l) => l.stage),
  };
}

function phone(seq) {
  const rows = seq
    .filter((m) => m.createdAt)
    .map((m, i) => ({ id: "m" + String(i).padStart(5, "0"), at: m.createdAt }))
    .sort((a, b) => (a.at === b.at ? (a.id < b.id ? -1 : 1) : a.at < b.at ? -1 : 1));
  const r = replay(rows);
  // 信匣口径 = 起点相识信 + 升阶各一封 + 当前阶段兜底一封（对齐电脑版 initialize）
  const targets = ["acquainted", ...r.promotions.map((p) => p.to)];
  if (targets.indexOf(r.stage) < 0) targets.push(r.stage);
  const uniq = [];
  for (const t of targets) if (uniq.indexOf(t) < 0) uniq.push(t);
  uniq.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  return {
    points: r.points,
    stage: r.stage,
    stageMessages: r.stageMessages,
    promotions: r.promotions.map((p) => p.to),
    letters: uniq,
  };
}

function day(n, hour, count) {
  const d = String(n).padStart(2, "0");
  const out = [];
  for (let i = 0; i < count; i++) {
    const hh = String(hour + Math.floor(i / 6)).padStart(2, "0");
    const mm = String((i * 7) % 60).padStart(2, "0");
    out.push({ role: i % 2 ? "assistant" : "user", createdAt: `2026-01-${d}T${hh}:${mm}:00.000Z` });
  }
  return out;
}

const cases = [
  ["单条", day(1, 9, 1)],
  ["同日两条", day(1, 9, 2)],
  ["两天各一条", [...day(1, 9, 1), ...day(2, 9, 1)]],
  ["29 条 3 天（卡条数）", [...day(1, 9, 10), ...day(2, 9, 10), ...day(3, 9, 9)]],
  ["30 条 3 天（升熟悉）", [...day(1, 9, 10), ...day(2, 9, 10), ...day(3, 9, 10)]],
  ["30 天每天 10 条", Array.from({ length: 30 }, (_, i) => day(i + 1, 9, 10)).flat()],
  ["每天 1 条 40 天", Array.from({ length: 40 }, (_, i) => day(i + 1, 9, 1)).flat()],
];

let bad = 0;
for (const [name, seq] of cases) {
  const d = desktop(seq);
  const p = phone(seq);
  const same =
    d.points === p.points &&
    d.stage === p.stage &&
    d.stageMessages === p.stageMessages &&
    JSON.stringify(d.letters) === JSON.stringify(p.letters);
  if (!same) {
    bad++;
    console.log("✗ " + name);
    console.log("   电脑 " + JSON.stringify(d));
    console.log("   手机 " + JSON.stringify(p));
  } else {
    console.log("✓ " + name + "  points=" + d.points + " stage=" + d.stage + " msgs=" + d.stageMessages + " 信=" + JSON.stringify(d.letters));
  }
}
console.log(bad ? "\n不一致 " + bad + " 例" : "\n全部一致");
process.exit(bad ? 1 : 0);
