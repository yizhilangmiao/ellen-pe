// time-guard 自测：真 node 直跑（手机版没有测试设施）
//   E:\ailian\工具\node\node-v24.21.0-win-x64\node.exe _tools\time-guard-selftest.mjs
import { guardReply, timeHits, inWindow } from '../app/web/src/app/core/time-guard.js';

let pass = 0;
let fail = 0;

function at(hour, minute = 0) {
  const d = new Date(2026, 10, 16, hour, minute, 0, 0);
  return d.getTime();
}

function check(name, got, want) {
  if (got === want) {
    pass += 1;
  } else {
    fail += 1;
    console.error(`✗ ${name}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`);
  }
}

// —— 窗口判断 ——
check('inWindow 同日 9-14 的 10 点', inWindow(10, 9, 14), true);
check('inWindow 同日 9-14 的 14 点（右开）', inWindow(14, 9, 14), false);
check('inWindow 跨夜 21-4 的 23 点', inWindow(23, 21, 4), true);
check('inWindow 跨夜 21-4 的 3 点', inWindow(3, 21, 4), true);
check('inWindow 跨夜 21-4 的 15 点', inWindow(15, 21, 4), false);

// —— 白天说晚安：该删 ——
{
  const r = guardReply('时候不早啦，快睡觉吧。', at(15));
  check('下午三点说快睡觉 → 删空后兜底', r.text, '嗯，我在。');
  check('下午三点说快睡觉 → 记下删了什么', r.removed.length, 1);
}

// —— 白天说晚安，但后面还有正经内容：只删错的 ——
{
  const r = guardReply('晚安。你今天怎么样？', at(15));
  check('下午三点：留后半句', r.text, '你今天怎么样？');
}

// —— 深夜说晚安：放过 ——
{
  const r = guardReply('晚安，早点睡。', at(23));
  check('晚上十一点说晚安 → 不动', r.changed, false);
  check('晚上十一点说晚安 → 原文保留', r.text, '晚安，早点睡。');
}

// —— 凌晨两点说晚安：也算合法（跨夜窗口）——
{
  const r = guardReply('晚安。', at(2));
  check('凌晨两点说晚安 → 不动', r.changed, false);
}

// —— 中午说早安：该删 ——
{
  const r = guardReply('早上好呀，昨晚睡得怎么样？', at(12));
  check('中午说早上好 → 删', r.text, '嗯，我在。');
}

// —— 早上说早安：放过 ——
{
  const r = guardReply('早安，昨晚睡得怎么样？', at(7));
  check('早上七点说早安 → 不动', r.changed, false);
}

// —— 「睡个午觉」不该被当晚安 ——
{
  const r = guardReply('我去睡个午觉。', at(13));
  check('下午一点说睡午觉 → 放过', r.changed, false);
}

// —— 晚上九点说晚饭：合法 ——
{
  const r = guardReply('晚饭吃了吗？', at(19));
  check('晚上七点说晚饭 → 不动', r.changed, false);
}

// —— 上午十点说晚饭：该删 ——
{
  const r = guardReply('晚饭吃了吗？', at(10));
  check('上午十点说晚饭 → 删', r.text, '嗯，我在。');
}

// —— 空回复不炸 ——
{
  const r = guardReply('', at(15));
  check('空串 → 原样返回', r.text, '');
  check('空串 → 不算改动', r.changed, false);
}

// —— timeHits 只报命中，不改文本 ——
{
  const h = timeHits('晚安，这么晚了还不睡。', at(15));
  check('timeHits 命中数', h.hits.length > 0, true);
  check('timeHits ok=false', h.ok, false);
}
{
  const h = timeHits('今天上班累不累。', at(15));
  check('普通句子不误报', h.ok, true);
}

console.log(`\ntime-guard: ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
