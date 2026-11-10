// 合并两份探针输出 → contract/ui-tokens.md（双主题变量对照 + 关键元素样式）
// 用法: node tokens_merge.js <style-probe.json> <theme-probe.json> <out.md>
const fs = require('fs');

const readJson = (p) => {
  const raw = fs.readFileSync(p, 'utf8');
  return JSON.parse(raw.slice(raw.indexOf('{')));
};

const dark = readJson(process.argv[2]);   // style-probe：暗色基线（:root/.ellen-app 定义）
const light = readJson(process.argv[3]);  // theme-probe：light 覆盖 + 当前生效值
const outPath = process.argv[4];

// 1) 收集暗色值：优先 live（当前 data-theme=dark 的计算值），settings 系用定义值
const darkVals = new Map();
for (const [k, v] of Object.entries(dark.customProps || {})) {
  if (v && v.val) darkVals.set(k, v.val);
}
for (const [k, v] of Object.entries(light.live || {})) {
  if (v) darkVals.set(k, v);   // live 覆盖（data-theme=dark 生效值）
}

// 2) 收集浅色覆盖：selector 含 data-theme="light"
const lightVals = new Map();
for (const [name, list] of Object.entries(light.defs || {})) {
  for (const entry of list) {
    const m = entry.match(/^(.*?) = (.*)$/);
    if (!m) continue;
    if (!/data-theme="light"/.test(m[1])) continue;
    if (lightVals.has(name)) continue;   // 同变量取第一条
    lightVals.set(name, m[2]);
  }
}

const skip = (v) => !v || /^var\(/.test(v);
const allNames = [...new Set([...darkVals.keys(), ...lightVals.keys()])].sort();

const lines = [];
lines.push('# 旧包 UI 令牌实测（b17 运行时 · 双主题）', '');
lines.push('来源：CDP 注入，遍历 35 张样式表读 `--el-*` / `--jr-*` 自定义属性 + `getComputedStyle` 取值。');
lines.push('主题挂载方式：`.ellen-app[data-theme="dark"|"light"]`（`<main id="app" class="ellen-app ellen-ui-root">`）。');
lines.push('基准屏 **432×936 CSS**（= 真机 864 物理 / dpr 2），dpr 2.5 时 1080×2400 物理。', '');

lines.push('## 一、颜色变量（暗 / 浅 对照）', '');
lines.push('| 变量 | 暗色（data-theme=dark） | 浅色（data-theme=light） |', '|---|---|---|');
for (const n of allNames) {
  const d = darkVals.get(n);
  const l = lightVals.get(n);
  if (skip(d) && skip(l)) continue;
  lines.push(`| \`${n}\` | ${d ? '`' + d + '`' : '—'} | ${l ? '`' + l + '`' : '（继承暗色）'} |`);
}
lines.push('');

lines.push('## 二、关键元素计算样式（暗色主题下实测）', '');
const FIELDS = ['color', 'background-color', 'font-family', 'font-size', 'font-weight', 'line-height',
  'letter-spacing', 'border-radius', 'padding', 'gap', 'box-shadow', 'backdrop-filter', 'opacity', 'border'];
for (const [name, o] of Object.entries(dark.el || {})) {
  if (!o) { lines.push(`- \`${name}\`：页面上不存在`); continue; }
  if (o.cls) { lines.push(`- \`${name}\`：cls=\`${o.cls}\` color=${o.color} bg=${o.bg} radius=${o.radius}`); continue; }
  const parts = [];
  for (const f of FIELDS) {
    const v = o[f];
    if (v && v !== 'none' && v !== 'normal' && v !== '0px' && v !== 'rgba(0, 0, 0, 0)') parts.push(`${f}=${v}`);
  }
  lines.push(`- \`${name}\` rect=${JSON.stringify(o._rect)}  ${parts.join(' · ')}`);
}
lines.push('');

lines.push('## 三、换算规则（M3 起硬执行）', '');
lines.push('旧包全部尺寸写在 432 CSS 宽基准屏上，单位就是 px。新 web 层**不写裸 px**，统一乘标尺：', '');
lines.push('```css');
lines.push('/* 1 单位 = 旧包的 1px，随屏缩放（432 宽时恰为 1px） */');
lines.push(':root { --u: clamp(0.84px, 0.2315vmin, 1.16px); }');
lines.push('/* 用法：旧包 26px → calc(26 * var(--u)) */');
lines.push('```');
lines.push('');
lines.push('- 只有 `1px` 细线、`0`、`box-shadow` 的模糊半径可保留原值。');
lines.push('- 纵向尺寸用 `vmin`（基准就是 vmin），**不要用 vw**（横屏 vw 会放大 4 倍）。');
lines.push('- 字体族统一 `EllenKuaiLe, "Microsoft YaHei", sans-serif`（字体文件在旧包 assets 里，M3 复制过来）。');

fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
console.log('written', outPath, lines.length, 'lines; vars', allNames.length, 'light-overrides', lightVals.size);
