// 统计旧 web 产物对 Capacitor 社区插件的引用次数（SystemBars / WebView / CapacitorHttp / CapacitorCookies）
const fs = require('fs');
const path = require('path');

const dir = 'work/assets/public/assets';
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && fs.statSync(path.join(dir, f)).size > 500000);
const names = ['SystemBars', 'WebView', 'CapacitorHttp', 'CapacitorCookies'];
const quotes = ['`', '"', "'"];

for (const n of names) {
  let total = 0;
  const samples = [];
  for (const f of files) {
    const t = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const q of quotes) {
      const needle = q + n + q;
      let i = 0;
      while ((i = t.indexOf(needle, i)) >= 0) {
        total++;
        if (samples.length < 3) samples.push(`${f}@${i} :: ${t.slice(Math.max(0, i - 130), i + 220).replace(/\n/g, ' ')}`);
        i += needle.length;
      }
    }
  }
  console.log(`== ${n} hits=${total}`);
  for (const s of samples) console.log('   ' + s);
}
