/* verify-traits.js · 验证「信随人变」+ 五阶字数
 * 用法：node verify-traits.js          只看摘要
 *       SHOW=1 node verify-traits.js   额外打印相识全文
 */
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "inject-letter.js"), "utf8");
const start = src.indexOf("var TOPICS = [");
const end = src.indexOf("/* ------------------------------------------------ 同步主流程 */");
if (start < 0 || end < 0) throw new Error("切片锚点没找到");
const slice = src.slice(start, end);

const prelude = [
  'var ORDER = ["acquainted","familiar","trusted","close","lover"];',
  'var LABELS = {acquainted:"相识",familiar:"熟悉",trusted:"信赖",close:"亲近",lover:"恋人"};',
  'var SIGNATURES = {acquainted:"——你的朋友艾莲",familiar:"——你的好朋友艾莲",trusted:"——艾莲",close:"——你的、就差一句话的艾莲",lover:"——你的恋人——爱你的鲨鱼"};',
  "var WORD_TARGET = {acquainted:1500,familiar:1500,trusted:1500,close:1500,lover:3000};",
  "var QUOTE_MAX = 24;",
  'var LAST_STAGE = "lover";',
  "function clip(s,n){var t=String(s==null?'':s).replace(/\\s+/g,' ').trim();if(!t)return '';var max=n||QUOTE_MAX;return t.length>max?t.slice(0,max)+'…':t;}",
  "function newId(){return 'x'+Math.random().toString(36).slice(2,8);}",
].join("\n");

const api = new Function(
  prelude + slice + "\nreturn {traits:traits,PICK:PICK,POOLS:POOLS,renderSegs:renderSegs,makeLetter:makeLetter};"
)();

function mk(list, baseDate) {
  // 本地时间构造：traits 用 getHours() 读小时
  const [y, mo, d] = baseDate.split("-").map(Number);
  return list.map(([h, text], i) => ({
    at: new Date(y, mo - 1, d, h, 0, i % 60).toISOString(),
    text,
  }));
}

const A = mk(
  [
    [1, "在吗"], [1, "干嘛呢"], [1, "今天好困"], [1, "你睡了吗"],
    [2, "猫又踩我"], [2, "烦死"], [2, "它不让我睡"], [2, "你说话啊"], [3, "算了"], [3, "晚安"],
    [23, "我又来了"], [23, "今天猫把我键盘咬了"], [23, "你说它是不是故意的"], [23, "哈哈"], [23, "我在等你回"],
    [2, "你怎么不说话"], [2, "是不是睡了"], [2, "算了没事"],
  ],
  "2026-10-01"
);

const B = mk(
  [
    [10, "今天早上开会，组长又把上个月的方案拿出来讲了一遍，我坐在下面听着，觉得挺没意思的。"],
    [10, "散会之后同事拉我去吃饭，路上一直在吐槽那个方案，我就听着，也没接话。"],
    [11, "其实我知道他说的对，但我不太想附和他，附和了就像是我也在抱怨一样。"],
    [14, "下午干了点活，把上周没做完的那部分补上了。做完了心里松了一点，虽然也没人看。"],
    [15, "说到这个，我朋友上周也遇到类似的事，他直接跟领导说了，结果被穿小鞋。我觉得他挺勇的，但我做不到。"],
    [18, "下班路上看见一家新开的面馆，人挺多的，我没进去，想着下次人少一点再去看看。"],
    [20, "晚上回来翻了翻书，看了两页就困了。今天就这些，没什么特别的。"],
    [21, "你呢，今天还好吗。"],
  ],
  "2026-09-20"
);

const C = mk([[12, "嗯"], [12, "好"]], "2026-10-28");

const STAGES = ["acquainted", "familiar", "trusted", "close", "lover"];
const NAME = { acquainted: "相识", familiar: "熟悉", trusted: "信赖", close: "亲近", lover: "恋人" };

let bad = 0;

function show(name, items, full) {
  const v = api.traits(items);
  console.log("=".repeat(66));
  console.log(
    `【${name}】 n=${v.n} 中位字数=${v.med} 提问率=${(v.ask * 100) | 0}% ` +
      `连发=${(v.burst * 100) | 0}% 无标点=${(v.punctNone * 100) | 0}% 时段=${v.hourBand} ` +
      `话题=${v.topic || "无"} 天数=${v.days}`
  );
  console.log("分支: " + Object.keys(api.PICK).map((k) => k + "=" + api.PICK[k](v)).join(" "));
  for (const st of STAGES) {
    const L = api.makeLetter(
      st,
      v,
      { points: 400, msgs: items.length, stageName: NAME[st], stageDate: "2026-10-30" },
      "2026-10-30T12:00:00+08:00"
    );
    const cn = (L.body.match(/[\u4e00-\u9fff]/g) || []).length;
    const left = /\{\{\w+\}\}/.test(L.body);
    if (left || cn < 600) bad += 1;
    console.log(
      `  ${st.padEnd(11)} ${L.title.padEnd(11)} 汉字=${String(cn).padStart(4)} 段=${L.body.split("\n\n").length}` +
        (left ? "  !! 残留占位符" : "") +
        (cn < 600 ? "  !! 不足600" : "")
    );
    if (full && st === "acquainted") console.log("\n" + L.body + "\n" + L.signature + "\n");
  }
}

show("A 短句·深夜·爱问·猫", A, !!process.env.SHOW);
show("B 长段·白天·讲别人", B);
show("C 兜底（只有两条）", C);

console.log("=".repeat(66));
console.log(bad ? `!! ${bad} 项不合格` : "✓ 五阶全部 600+ 字、无残留占位符");
process.exit(bad ? 1 : 0);
