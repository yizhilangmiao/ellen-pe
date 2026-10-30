"use strict";
/* 手机端记忆改造 ③④ 测试：从 work 的 bundle 里抽真实代码跑。
   ④ 的邻近路是独立 IIFE，单独喂数据即可验证（Vl 需要完整 store 记录结构，不在这里造）。 */
const fs = require("node:fs");
const path = require("node:path");

const ASSETS = path.join(__dirname, "work", "assets", "public", "assets");
const svc = fs.readFileSync(path.join(ASSETS, "service-DGjhUELY.js"), "utf8");

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log("  PASS " + name + (extra ? "  " + extra : "")); }
  else { fail++; console.log("  FAIL " + name + (extra ? "  " + extra : "")); }
};

// 真实 rrf（gl）：从 bundle 里抽
const segStart = svc.indexOf("var pl=e=>{");
const segEnd = svc.indexOf("function Hl(", segStart);
const glSrc = svc.slice(svc.indexOf("function gl(e,{k:t=60"), svc.indexOf("var _l="));
const gl = new Function("return " + glSrc + "\n;return gl;")();

// ---------------------------------------------------------------- ④ 邻近共现
console.log("[④] 邻近共现召回路");

const i0 = svc.indexOf("const nl=(()=>{");
if (i0 < 0) throw new Error("bundle 里找不到 ④ 邻近路");
const i1 = svc.indexOf("})();", i0) + 5;
const nlSrc = svc.slice(i0 + "const nl=".length, i1);
const makeNl = new Function("gl", "f", "o", "z", "s", "return " + nlSrc + ";");

const mk = (id, anchorAt) => ({ id, text: id, anchorAt, state: "active", strength: 1 });
const a = mk("mem-a", "2026-10-01T10:00:00.000Z");
const b = mk("mem-b", "2026-10-01T10:10:00.000Z");   // 10 分钟内
const c = mk("mem-c", "2026-09-01T10:00:00.000Z");   // 一个月前
const d = mk("mem-d", "2026-10-01T10:25:00.000Z");   // 25 分钟，超窗
const all = [a, b, c, d];
const docIds = (l) => l.map((x) => x.doc.id);

const r1 = makeNl(gl, [{ doc: a, score: 1 }], [], [], all);
console.log("  种子 mem-a 的邻居:", JSON.stringify(docIds(r1)));
ok("±15 分钟内的 mem-b 带出", docIds(r1).includes("mem-b"));
ok("10 分钟前/后的方向都能取到", docIds(r1).length >= 1);
ok("25 分钟的 mem-d 不带出（超窗）", !docIds(r1).includes("mem-d"));
ok("一个月前的 mem-c 不带出", !docIds(r1).includes("mem-c"));
ok("种子自身不重复进邻近路", !docIds(r1).includes("mem-a"));

const r2 = makeNl(gl, [{ doc: c, score: 1 }], [], [], all);
ok("孤立记忆（mem-c）邻居为空", r2.length === 0, JSON.stringify(docIds(r2)));

const noAnchor = [{ id: "mem-x", text: "没锚点", state: "active" }, a];
let threw = false;
let r3 = [];
try { r3 = makeNl(gl, [{ doc: a, score: 1 }], [], [], noAnchor); } catch { threw = true; }
ok("记忆缺 anchorAt 时不抛", !threw);
ok("缺锚点的记忆不会被当邻居", !docIds(r3).includes("mem-x"));

const emptyS = makeNl(gl, [{ doc: a, score: 1 }], [], [], []);
ok("记忆列表为空时返回空", emptyS.length === 0);

// 数量上限：邻近路自身不限条数，但融合时只取前 12（这里验证融合入口确实是 12）
ok("融合时邻近路截到 12 条", svc.includes("nl.slice(0,12)"));
ok("邻近路已加进 rrf 第四路", /gl\(\[f\.slice\(0,24\),o\.slice\(0,24\),z\.slice\(0,24\),nl\.slice\(0,12\)\]/.test(svc));

// ---------------------------------------------------------------- ③ 惰性维护
console.log("[③] 惰性周期维护");

const p3 = fs.readFileSync(path.join(__dirname, "_patch_phone_memory2.py"), "utf8");
const m3 = p3.match(/P3_NEW = \(\n([\s\S]*?)\n\)\n/);
if (!m3) throw new Error("补丁脚本里找不到 P3_NEW");
const p3src = m3[1].split("\n").map((l) => l.trim())
  .filter((l) => l.startsWith('"')).map((l) => l.replace(/^"/, "").replace(/"$/, "")).join("");
const iife = p3src.slice(p3src.indexOf("("), p3src.indexOf(";let{view:y}="));
ok("节流窗口是 30 分钟（18e5 毫秒）", p3src.includes("18e5"));
ok("心跳存在 localStorage 的 ellen-mem-maint-at", p3src.includes("ellen-mem-maint-at"));
ok("③ 已插到 je 的取视图之前", svc.includes("})();let{view:y}=_||await H("));

let store = {}, calls = 0;
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
};
const T = { recoverInterrupted: () => { calls++; return Promise.resolve(); } };
const run3 = () => new Function("T", "return " + iife + ";")(T);
run3();
run3();

setTimeout(() => {
  ok("首次触发，30 分钟内第二次被节流", calls === 1, "calls=" + calls);

  store["ellen-mem-maint-at"] = String(Date.now() - 31 * 60 * 1e3);
  run3();
  setTimeout(() => {
    ok("超过 30 分钟后再次触发", calls === 2, "calls=" + calls);

    let threw = false;
    try { new Function("T", "return " + iife + ";")({}); } catch { threw = true; }
    ok("整理 API 不存在时不抛", !threw);

    let threw2 = false;
    try { new Function("T", "return " + iife + ";")(null); } catch { threw2 = true; }
    ok("T 为 null 时也不抛", !threw2);

    console.log();
    console.log("通过 " + pass + " / 失败 " + fail);
    process.exit(fail ? 1 : 0);
  }, 10);
}, 10);
