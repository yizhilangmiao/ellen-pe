# -*- coding: utf-8 -*-
"""手机版记忆·合并（consolidation）

问题：上游 Dl() 用「summary 完全相同」分桶，Cl() 的分组键又把「证据来源指纹」
算进去。于是「正在做的事 · 今天有点累」和「生活与近况 · 今天有点累」永远合不上，
同一件事每说一次就多一条。

改法（只动 Dl 两处，不碰 Cl / Nl，风险最小）：
  1. 新增 __ellenMemCore()：去掉「xx · 」标题前缀并归一化空白。
  2. 新增 __ellenMemSim()：共字数 / 较长串长度，作为归桶相似度。
  3. Dl() 分桶改为「找相似度 >= 0.62 的已有桶」。
  4. Dl() 的分组键改为归一化 summary（同桶内即视为同组）。

合并后的主记忆带 relatedMemories（组内其余成员），原文一个字都没丢。
"""
import io
import shutil
import sys

SRC = r'E:\ailian\艾莲手机版\创作版\work\assets\public\assets\service-DGjhUELY.js'
BAK = SRC + '.bak-memmerge'
MARK = '/* ellen-mem-merge */'

HELPERS = (
    'var __ellenMemMark = `' + MARK + '`;\n'
    'function __ellenMemCore(s) {\n'
    '  var t = String(s == null ? `` : s).replace(/\\s+/gu, ` `).trim();\n'
    '  var i = t.indexOf(`\\xB7`);\n'
    '  if (i < 0) i = t.indexOf(`\\u30FB`);\n'
    '  if (i > 0 && i <= 12) t = t.slice(i + 1).trim();\n'
    '  return t;\n'
    '}\n'
    'function __ellenMemSim(a, b) {\n'
    '  var x = __ellenMemCore(a), y = __ellenMemCore(b);\n'
    '  if (!x || !y) return 0;\n'
    '  if (x === y) return 1;\n'
    '  var sx = new Set(x.split(``)), sy = new Set(y.split(``)), c = 0;\n'
    '  sx.forEach(function (ch) { if (sy.has(ch)) c++; });\n'
    '  return c / Math.max(sx.size, sy.size);\n'
    '}\n'
)

OLD_BUCKET = (
    '    let e9 = (_a2 = t3.summary) == null ? void 0 : _a2.trim().replace(/\\s+/gu, ` `);\n'
    '    n2.has(e9) || n2.set(e9, []), n2.get(e9).push(t3);'
)
NEW_BUCKET = (
    '    let e9 = __ellenMemCore((_a2 = t3.summary) == null ? void 0 : _a2);\n'
    '    if (e9) { let __hit = null; for (let __k of n2.keys()) if (__ellenMemSim(__k, e9) >= 0.62) { __hit = __k; break; } __hit !== null && (e9 = __hit); }\n'
    '    n2.has(e9) || n2.set(e9, []), n2.get(e9).push(t3); ' + MARK
)

OLD_KEY = 'let e10 = t2(n3), a3 = Cl(n3.summary, e10);'
NEW_KEY = 'let e10 = t2(n3), a3 = __ellenMemCore(n3.summary) || Cl(n3.summary, e10); ' + MARK


def main():
    s = io.open(SRC, encoding='utf-8').read()
    mode = sys.argv[1] if len(sys.argv) > 1 else ''

    if mode == '--check':
        print('mark        ', s.count(MARK))
        print('helper core ', s.count('function __ellenMemCore'))
        print('helper sim  ', s.count('function __ellenMemSim'))
        print('old bucket  ', s.count(OLD_BUCKET))
        print('new bucket  ', s.count(NEW_BUCKET))
        print('old key     ', s.count(OLD_KEY))
        print('new key     ', s.count(NEW_KEY))
        return

    if mode == '--revert':
        shutil.copyfile(BAK, SRC)
        t = io.open(SRC, encoding='utf-8').read()
        print('[revert] len', len(t), 'mark', t.count(MARK))
        return

    if MARK in s:
        print('[already]')
        return

    ok = True
    for nm, frag in [('OLD_BUCKET', OLD_BUCKET), ('OLD_KEY', OLD_KEY)]:
        c = s.count(frag)
        print('  %-11s %d' % (nm, c))
        if c != 1:
            ok = False
    if not ok:
        print('[fail] 锚点不唯一，未写入')
        return

    before = len(s)
    shutil.copyfile(SRC, BAK)
    i = s.index('function Dl(')
    s = s[:i] + HELPERS + s[i:]
    s = s.replace(OLD_BUCKET, NEW_BUCKET, 1)
    s = s.replace(OLD_KEY, NEW_KEY, 1)
    io.open(SRC, 'w', encoding='utf-8', newline='').write(s)

    print('[applied] %d -> %d  delta %+d' % (before, len(s), len(s) - before))
    chk = io.open(SRC, encoding='utf-8').read()
    assert chk.count(MARK) == 3, 'mark=%d' % chk.count(MARK)
    assert chk.count('function __ellenMemCore') == 1
    assert chk.count('function __ellenMemSim') == 1
    assert chk.count(OLD_BUCKET) == 0
    assert chk.count(OLD_KEY) == 0
    assert chk.count('function Dl(') == 1
    print('  [self-check] ok')


main()
