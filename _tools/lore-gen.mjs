// 生成器：把电脑版素材里的「世界书」「表达样本」压成手机版 ES 模块。
// 为什么用脚本而不是手抄：34 条世界书 + 28 个场景手抄必错字，且以后电脑版更新素材要能重跑。
//
// 收进仓库的理由（2026-11-13）：原来它躺在 _临时\（被 .gitignore 忽略、还有「>10 GB 自动清理」），
// 素材一更新、脚本一没，assets\lore\ 就成了没法重生成的黑盒。
//
// 用法：node _tools\lore-gen.mjs   （路径按仓库位置自动推，换机器不用改）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SRC = 'E:/ailian/艾莲电脑版/创作版/resources/app/characters/ellen';
const OUT = path.join(REPO, 'app/web/src/app/assets/lore');

function clip(s, max) {
  const str = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (str.length <= max) return str;
  // 尽量在句末断开，找不到句末就硬切（运行时还会再截，这里只是控制包体）
  const head = str.slice(0, max);
  const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('；'), head.lastIndexOf('！'), head.lastIndexOf('？'));
  return cut > max * 0.55 ? head.slice(0, cut + 1) : head;
}

// 世界书 content 是 JSON 字符串：{"资料性质": "...", "内容": string | object}
// 「资料性质」每条都一样，纯噪音，丢掉；「内容」是对象时摊平成「键：值」便于阅读与截断。
function flatten(obj) {
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    if (k === '资料性质' || k === '原作条目') continue;
    const val = Array.isArray(v) ? v.join('、') : (v && typeof v === 'object' ? flatten(v) : String(v ?? ''));
    if (!val) continue;
    parts.push(`${k}：${val}`);
  }
  return parts.join('｜');
}

// ── 口语触发词补丁（后排「老大 2026-11-13」定的第 6 条）──
// 原素材的 keys 全是剧情专名（莱卡恩 / 以太绮梦 / 芭莱大厦），日常一句「今天好累」
// 一条都命中不了，lore 段就只剩常驻卡。这里给四条最常被聊到的往事挂上口语词，
// 只加词、不动正文 —— 命中后的内容仍是电脑版原话。
const COLLOQUIAL = {
  'anchor-0': ['累', '上班', '加班', '工作', '休息', '没力气'], // 工作结束之前还不能休息
  'memory-0': ['累', '上班', '加班', '工作'],
  'anchor-4': ['睡', '困', '熬夜', '睡着了'], // 守约的人也可能累到睡着
  'anchor-6': ['吃', '饭', '好吃', '零食'], // 亲近没有取消选择权
  'anchor-3': ['危险', '救人', '安全'], // 朋友安全比掩饰更要紧
};

const wbRaw = JSON.parse(fs.readFileSync(path.join(SRC, '背景补充世界书.json'), 'utf8'));
const wb = [];
for (const e of wbRaw.entries) {
  if (e.enabled === false) continue;
  let c = null;
  try { c = JSON.parse(e.content); } catch { /* 老条目可能直接是纯文本 */ }
  const inner = c && typeof c === 'object' && '内容' in c ? c['内容'] : e.content;
  const text = clip(typeof inner === 'string' ? inner : flatten(inner), 300);
  const extra = COLLOQUIAL[e.id] || [];
  const keys = [...(e.keys || [])];
  for (const k of extra) if (!keys.includes(k)) keys.push(k);
  wb.push({ id: e.id, t: e.comment || e.id, keys, x: text });
}

const smRaw = JSON.parse(fs.readFileSync(path.join(SRC, '表达样本.json'), 'utf8'));
const sm = [];
for (const sc of smRaw.scenes) {
  const ex = sc.examples || {};
  // 取「亲近」档的口吻，太长的退回 exact[0]，再长就截断
  let line = clip(ex.close || '', 48);
  if (!line) line = clip((sc.exact || [])[0] || '', 48);
  if (!line) continue;
  const cue = clip((sc.cues || [])[0] || sc.title, 12);
  sm.push({ c: cue, l: line });
}

const head = `// 由 _tools\\\\lore-gen.mjs 生成，勿手改：素材源在电脑版 characters\\\\ellen。
// 为什么单独成文件：世界书 34 条 / 表达样本 28 条体积远大于常驻段，分模块便于按需引用与后续重生成。
`;

const wbBody = `${head}
// 背景补充世界书：运行时按用户那句话做关键词命中，每次最多取 2 条（见 core/lore.js）。
// keys = 素材原词 + 几条口语触发词（脚本里的 COLLOQUIAL，别在这里手改，重跑会覆盖）；
// x 已去掉每条重复的「资料性质」，只留正文。
export default ${JSON.stringify(wb, null, 0)};
`;
const smBody = `${head}
// 表达样本：只留「一句口吻示例」，运行时随机 2-3 条塞进 lore 段（撑语气，不撑信息）。
// c = 线索词，l = 台词；完整 scene 结构留在电脑版，手机版不需要。
export default ${JSON.stringify(sm, null, 0)};
`;

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'ellen-worldbook.js'), wbBody, 'utf8');
fs.writeFileSync(path.join(OUT, 'ellen-samples.js'), smBody, 'utf8');

console.log('worldbook entries:', wb.length, 'bytes:', Buffer.byteLength(wbBody));
console.log('samples:', sm.length, 'bytes:', Buffer.byteLength(smBody));
console.log('wb avg text chars:', (wb.reduce((a, b) => a + b.x.length, 0) / wb.length).toFixed(1));
console.log('colloquial patched:', Object.keys(COLLOQUIAL).filter((id) => wb.some((w) => w.id === id)).join(','));
