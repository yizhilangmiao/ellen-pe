// 在旧 web bundle 里按关键词取上下文（避免整行打印把上下文烧光）
const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
const needle = process.argv[3];
const before = Number(process.argv[4] || 300);
const after = Number(process.argv[5] || 700);

for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.js')) continue;
  const s = fs.readFileSync(path.join(dir, f), 'utf8');
  let i = -1;
  let count = 0;
  while ((i = s.indexOf(needle, i + 1)) !== -1 && count < 4) {
    count++;
    const start = Math.max(0, i - before);
    const end = Math.min(s.length, i + after);
    console.log(`\n=== ${f} @${i} ===`);
    console.log(s.slice(start, end).replace(/\n/g, ' ⏎ '));
  }
}
