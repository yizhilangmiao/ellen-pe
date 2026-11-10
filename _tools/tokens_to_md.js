// 把 style-probe 输出转成可读 md（变量表 + 关键元素计算样式）
const fs = require('fs');
const path = process.argv[2];
const raw = fs.readFileSync(path, 'utf8');
const start = raw.indexOf('{');
const data = JSON.parse(raw.slice(start));

const lines = [];
lines.push('# 旧包 UI 令牌实测（b17 运行时）', '');
lines.push('来源：CDP 注入 `getComputedStyle` + 遍历全部样式表读自定义属性。');
lines.push(`样式表 ${data.sheets} 张、规则 ${data.rules} 条。`, '');
lines.push('## 一、CSS 自定义属性（按定义处选择器分组）', '');

const groups = new Map();
for (const [name, { sel, val }] of Object.entries(data.customProps)) {
  if (!groups.has(sel)) groups.set(sel, []);
  groups.get(sel).push([name, val]);
}
for (const [sel, list] of groups) {
  lines.push(`### 定义于 \`${sel}\``, '', '| 变量 | 值 |', '|---|---|');
  for (const [n, v] of list) lines.push(`| \`${n}\` | \`${v}\` |`);
  lines.push('');
}

lines.push('## 二、关键元素计算样式', '');
const FIELDS = ['color', 'background-color', 'font-family', 'font-size', 'font-weight', 'line-height',
  'letter-spacing', 'border-radius', 'padding', 'gap', 'box-shadow', 'backdrop-filter', 'opacity', 'border'];
for (const [name, o] of Object.entries(data.el || {})) {
  if (!o) { lines.push(`- \`${name}\`：**页面上不存在**`); continue; }
  if (o.cls) { lines.push(`- \`${name}\`：cls=\`${o.cls}\` color=${o.color} bg=${o.bg} radius=${o.radius}`); continue; }
  const parts = [];
  for (const f of FIELDS) {
    const v = o[f];
    if (v && v !== 'none' && v !== 'normal' && v !== '0px' && v !== 'rgba(0, 0, 0, 0)') parts.push(`${f}=${v}`);
  }
  lines.push(`- \`${name}\` rect=${JSON.stringify(o._rect)}`, `  - ` + parts.join(' · '));
}
lines.push('');
lines.push(`html.class = \`${data.htmlClass || ''}\` · body.class = \`${data.bodyClass || ''}\` · #app.class = \`${data.rootClass || ''}\``);

const out = 'E:/ailian/艾莲手机版/创作版/contract/ui-tokens.md';
fs.writeFileSync(out, lines.join('\n'), 'utf8');
console.log('written', out, lines.length, 'lines');
