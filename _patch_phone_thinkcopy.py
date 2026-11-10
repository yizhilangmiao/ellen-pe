# -*- coding: utf-8 -*-
"""补最后 3 处没命中的旧文案（它们是模板拼接或藏在 service chunk 里）。

1) main : `请选择` + `准备使用的平台`  →  请选择你买 Key 的平台
2) service : 思考档位 off 的描述
3) service : budgetDescription 的三目模板（含 `+ i3.maxTokens +` 拼接）→ 单句白话
"""
import io
import os
import re
import shutil
import sys

ROOT = r'E:\ailian\艾莲手机版\创作版'
MAIN = os.path.join(ROOT, 'work', 'assets', 'public', 'assets', 'main-CFFhpb4h.js')
SVC = os.path.join(ROOT, 'work', 'assets', 'public', 'assets', 'service-DGjhUELY.js')
MARK = '/* ellen-think-copy */'


def esc(s):
    return ''.join(('\\u%04X' % ord(c)) if ord(c) > 127 else c for c in s)


def loose(s):
    out = []
    for c in s:
        o = ord(c)
        if o < 128:
            out.append(re.escape(c))
        elif o < 0x100:
            out.append('(?:\\\\u%04X|\\\\x%02X|\\\\u%04x|%s)' % (o, o, o, re.escape(c)))
        else:
            out.append('(?:\\\\u%04X|\\\\u%04x|%s)' % (o, o, re.escape(c)))
    return ''.join(out)


# ---- main：下拉框占位符 ----
MAIN_OLD = '`准备使用的平台`'
MAIN_NEW = '`你买 Key 的平台`'

# ---- service：思考档位 off ----
SVC_OFF_OLD = 'off: `不使用额外思考模式。`'
SVC_OFF_NEW = 'off: `不多想，直接答。`'

# ---- service：额度说明三目模板（从 START 到 END 整段替换）----
BD_START = 'r3.separateBudget || [`qwen`, `qwen-levels`].includes(r3.kind) ? '
BD_END = '\\u4E0A\\u9650\\u4E0D\\u4EE3\\u8868\\u5B9E\\u9645\\u7528\\u91CF\\u3002`'
BD_NEW = '`想得越深，等得越久，也越费额度。`'


def main():
    arg = sys.argv[1] if len(sys.argv) > 1 else ''

    m = io.open(MAIN, encoding='utf-8').read()
    s = io.open(SVC, encoding='utf-8').read()

    if arg == '--check':
        print('[main  准备使用的平台] hits=', len(re.findall(loose(MAIN_OLD), m)))
        print('[svc   off 描述      ] hits=', len(re.findall(loose(SVC_OFF_OLD), s)))
        i = s.find(BD_START)
        j = s.find(BD_END, i) if i >= 0 else -1
        print('[svc   budget 三目   ] start=%d end=%d' % (i, j))
        return

    if m.count(MARK) or s.count(MARK):
        print('[already]')
        return

    # 1) main
    hits = list(re.finditer(loose(MAIN_OLD), m))
    assert len(hits) == 1, 'main hits=%d' % len(hits)
    h = hits[0]
    m2 = m[:h.start()] + '`' + esc('你买 Key 的平台') + '`' + m[h.end():]
    assert m2.count('\\u4F60\\u4E70 Key') == 1
    io.open(MAIN, 'w', encoding='utf-8', newline='').write(MARK + '\n' + m2)

    # 2) service off 描述
    hits = list(re.finditer(loose(SVC_OFF_OLD), s))
    assert len(hits) == 1, 'svc off hits=%d' % len(hits)
    h = hits[0]
    s2 = s[:h.start()] + 'off: `' + esc('不多想，直接答。') + '`' + s[h.end():]

    # 3) service budget 三目
    i = s2.find(BD_START)
    assert i >= 0, 'bd start not found'
    j = s2.find(BD_END, i)
    assert j >= 0, 'bd end not found'
    j += len(BD_END)
    seg = s2[i:j]
    assert seg.count('i3.maxTokens') == 3, seg.count('i3.maxTokens')
    s2 = s2[:i] + BD_NEW + s2[j:]
    assert 'i3.maxTokens' not in s2
    io.open(SVC, 'w', encoding='utf-8', newline='').write(MARK + '\n' + s2)

    print('[applied] main', len(m), '->', len(m2), '| svc', len(s), '->', len(s2))
    print('[self] mark main=', io.open(MAIN, encoding='utf-8').read().count(MARK),
          'svc=', io.open(SVC, encoding='utf-8').read().count(MARK))


main()
