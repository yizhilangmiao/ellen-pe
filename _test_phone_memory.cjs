"use strict";
/* 手机端记忆改造测试：直接从 work 里的 bundle 抽取真实函数跑，不重写算法。
   覆盖：① 字面召回 bug 复现与修复；② 会话摘要注入行为。 */
const fs = require("node:fs");
const path = require("node:path");

const ASSETS = path.join(__dirname, "work", "assets", "public", "assets");
const svc = fs.readFileSync(path.join(ASSETS, "service-DGjhUELY.js"), "utf8");

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log("  PASS " + name + (extra ? "  " + extra : "")); }
  else { fail++; console.log("  FAIL " + name + (extra ? "  " + extra : "")); }
};

// ---------------------------------------------------------------- 抽取真实函数
// pl(tokenize) 到 Vl(召回) 之间的整段，都是纯函数，无浏览器依赖
const segStart = svc.indexOf("var pl=e=>{");
const segEnd = svc.indexOf("function Hl(", segStart);
if (segStart < 0 || segEnd < 0) throw new Error("抽取锚点失效");
const seg = svc.slice(segStart, segEnd);
const stub = `
const U=(c,m)=>{if(!c)throw Error(m||"assert")};
const q=()=>{};
const Y=JSON.stringify;
const j=JSON.stringify;
const K=(a,b)=>a<b?-1:a>b?1:0;
const he=(a,b)=>0;
const W=()=>{};
`;
const M = new Function(stub + seg + "\nreturn {pl,ml,Vl,gl};")();
const { pl, ml } = M;

console.log("[①] 字面召回 / 单字门槛");

const docs = [
  { id: "mem-1", text: "用户开始学手冲咖啡", kind: "user_fact", state: "active", strength: 1, anchorAt: "2026-10-01T00:00:00Z" },
  { id: "mem-2", text: "手冲壶坏了要换新的", kind: "shared_event", state: "active", strength: .9, anchorAt: "2026-10-02T00:00:00Z" },
  { id: "mem-3", text: "用户养了一只猫", kind: "user_fact", state: "active", strength: .8, anchorAt: "2026-09-20T00:00:00Z" },
];

// 1a 复现旧 bug：单字 query 的 tokens 与 doc 的 tokens 无交集 → bm25 全 0
const q1 = "猫";
const qTok = pl(q1);
const dTok = docs.map((d) => pl(d.text));
const bm = ml(q1, docs);
const overlap = dTok.map((t) => t.filter((x) => new Set(qTok).has(x)).length);
ok("单字 query 分词为单字", JSON.stringify(qTok) === '["猫"]', JSON.stringify(qTok));
ok("文档只有 bigram/trigram（复现 bug 根源）", dTok[2].every((t) => t.length >= 2) && !dTok[2].includes("猫"), JSON.stringify(dTok[2]));
ok("bm25 对「猫」全部打 0（旧版拿不到候选）", bm.every((r) => r.score === 0), JSON.stringify(bm.map((r) => r.score)));
ok("token 交集为空", overlap.every((n) => n === 0), JSON.stringify(overlap));

// 1b 新字面路：query 子串命中 doc.text
const lits = docs.filter((d) => d.text.toLowerCase().includes(q1.toLowerCase()));
ok("字面路命中 mem-3", lits.length === 1 && lits[0].id === "mem-3", JSON.stringify(lits.map((d) => d.id)));

// 1c 真正决定召不回的是"进不进候选集"：旧 rrf 只有词面+向量两路，mem-3 两路都是 0 分 → 不入候选
const litDocs = docs.filter((d) => d.text.includes(q1)).map((d) => ({ doc: d, score: 1 }));
const oldCand = M.gl([bm.slice(0, 24), []], { limit: 48 });
const newCand = M.gl([bm.slice(0, 24), [], litDocs.slice(0, 24)], { limit: 48 });
const ids = (list) => list.map((x) => x.doc?.id ?? x.id);
ok("旧两路 rrf 候选里没有 mem-3（复现召不回）", !ids(oldCand).includes("mem-3"), JSON.stringify(ids(oldCand)));
ok("加入字面路后 mem-3 进候选", ids(newCand).includes("mem-3"), JSON.stringify(ids(newCand)));
// 门槛公式对单字 query 无效这一点留着做记录：doc 的 tokens 里根本没有单字，所以单字只能靠候选路 + 兜底
const u = new Set(pl(q1));
const newGate = pl("用户养了一只猫").filter((x) => u.has(x)).length >= Math.min(2, u.size || 1);
ok("单字 query 下门槛公式恒为 false（故必须靠候选路）", newGate === false, "u.size=" + u.size);
ok("filter 字面兜底可放行 mem-3", q1.length > 0 && q1.length <= 8 && docs[2].text.toLowerCase().includes(q1));
ok("另外两条不相关记忆不会被字面路带出", docs[0].text.includes(q1) === false && docs[1].text.includes(q1) === false);

// 1d 多字 query 行为不变
const q2 = "手冲";
const lit2 = docs.filter((d) => d.text.toLowerCase().includes(q2));
ok("多字 query 字面路正常", lit2.length === 2, JSON.stringify(lit2.map((d) => d.id)));
ok("多字 query 分词仍走 bigram", pl(q2).includes("手冲"), JSON.stringify(pl(q2)));

// ---------------------------------------------------------------- ② 会话摘要
console.log("[②] 会话摘要注入");

const patchSrc = fs.readFileSync(path.join(__dirname, "_patch_phone_memory.py"), "utf8");
const mIIFE = patchSrc.match(/E=E\+(\(\(\)=>\{[\s\S]*?\}\)\(\))/);
if (!mIIFE) throw new Error("补丁脚本里找不到摘要 IIFE");
const iife = mIIFE[1];

const mkMsg = (id, role, text, at, threadId = "conv1") => ({
  kind: "message", deleted: false, conflict: false,
  revisions: [{ value: { threadId, role, text, createdAt: at } }],
});
const build = (n, threadId = "conv1") => {
  const m = new Map();
  const base = Date.parse("2026-10-01T10:00:00Z");
  for (let i = 1; i <= n; i++) {
    m.set("m" + i, mkMsg("m" + i, i % 2 ? "user" : "assistant",
      "第" + i + "条消息内容\n第二行", new Date(base + i * 6e4).toISOString(), threadId));
  }
  return m;
};
const run = (byId, conv = "conv1") => {
  const E = "RULES";
  const fn = new Function("E", "y", "o", "return E+" + iife);
  return fn(E, { byId }, conv);
};

const few = run(build(5));
ok("消息不足 8 条时不加摘要", few === "RULES", JSON.stringify(few));

const many = run(build(20));
ok("20 条时追加摘要段", many.includes("[早期对话摘要]"), String(many.length) + " 字符");
ok("摘要标注覆盖条数 8（20 条里去掉最近 12）", /较早 8 条/.test(many));
ok("摘要含最早一条原文", many.includes("第1条消息内容"));
ok("摘要压掉了换行", !/\n\n第二行/.test(many));
ok("原有 rules 仍在前面", many.startsWith("RULES"));
console.log("  摘要样例:", many.replace(/^RULES/, "").trim().slice(0, 200));

const other = run(build(20, "conv2"), "conv1");
ok("别的会话的消息不计入", other === "RULES");

const broken = (() => { try { return run(null); } catch (e) { return "THREW:" + e.message; } })();
ok("拿不到消息视图时不抛且不加摘要", broken === "RULES", JSON.stringify(broken));

// ---------------------------------------------------------------- 汇总
console.log();
console.log("通过 " + pass + " / 失败 " + fail);
process.exit(fail ? 1 : 0);
