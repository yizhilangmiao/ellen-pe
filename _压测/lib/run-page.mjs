// 单跑一个 page/*.js，不编排场景、不出 md。排查和一次性核查用。
//
//   node lib/run-page.mjs page/purge-orphans.js                 # dry-run
//   node lib/run-page.mjs page/purge-orphans.js '{"apply":true}' # 真删
//
// 认的开关只有三个：--port（默认 9222）、--serial（默认 127.0.0.1:16448）、--no-adb。
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { connect } from './cdp.mjs';
import { findAdb, forwardWebView } from './adb.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PRELUDE = join(HERE, '..', 'lib', 'prelude.js');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v === undefined ? true : v;
};

const noAdb = flag('--no-adb', false) === true;
const port = Number(flag('--port', 9222));
const serial = String(flag('--serial', '127.0.0.1:16448'));

const [file, argsJson] = argv;
if (!file) {
  console.error('用法: node lib/run-page.mjs page/<名字>.js [ARGS JSON]');
  process.exit(2);
}
const ARGS = argsJson ? JSON.parse(argsJson) : {};

if (!noAdb) {
  const fwd = forwardWebView({ adb: findAdb(), serial, port });
  console.error(`[adb] pid=${fwd.pid} → tcp:${port}`);
}

const [prelude, body] = await Promise.all([readFile(PRELUDE, 'utf8'), readFile(join(HERE, '..', 'page', file.replace(/^page\//, '')), 'utf8')]);
const expr = `(async () => { ${prelude}\n return await (${body})(${JSON.stringify(ARGS)}); })()`;

const cdp = await connect(port);
try {
  const out = await cdp.evaluate(expr, { timeoutMs: 600000 });
  console.log(JSON.stringify(out, null, 2));
} finally {
  cdp.close();
}
