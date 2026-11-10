# -*- coding: utf-8 -*-
"""聊天模型配置向导：补上第一轮漏掉的 11 处旧文案（只改文案，不动结构）。

沿用 _patch_phone_voicecopy.py 的宽松正则匹配：
源文件里中文既可能是 \\uXXXX 也可能出现 \\xB7 这类两位十六进制。
替换统一写成 \\uXXXX。

每条允许指定预期命中次数（None = 必须唯一命中，否则跳过不动）。
"""
import os
import re
import shutil
import sys

ROOT = r'E:\ailian\艾莲手机版\创作版'
TARGET = os.path.join(ROOT, 'work', 'assets', 'public', 'assets', 'main-CFFhpb4h.js')
BAK = TARGET + '.bak-chatcopy2'
MARK = '/* ellen-chat-copy2 */'


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


PAIRS = [
    # 顶部当前模型卡片说明
    ('`已保存的模型继续用于聊天，新服务只有明确选用后才切换。`',
     '`现在用的还是这个。选了新的才会换。`', None),
    # 领 Key 引导
    ('`还没有 Key？先去创建`',
     '`还没有 Key？点这里去领一枚`', 2),
    ('`先到官方平台创建，拿到后回这里填写。已有 Key 可直接跳过。`',
     '`点进去领一枚，回来粘上就行。`', None),
    # 平台选择
    ('`准备使用哪个平台？`',
     '`Key 是从哪家买的？`', None),
    ('`请选择准备使用的平台`',
     '`点这里选平台`', None),
    # 购买类型说明
    ('`按购买页名称选择普通 API、Agent Plan、Token Plan 等；不同平台的选项会不同。地址会相应填写，专属地址可直接修改。`',
     '`按你买的时候看到的名称选。选完地址会自动填好。`', None),
    # 服务地址
    ('`服务地址（可修改）`',
     '`服务器地址（能改）`', None),
    # Key 输入框 placeholder
    ('`留空保留这个服务的已保存 Key`',
     '`不填就沿用已存的 Key`', None),
    # 模型清单
    ('`先获取模型列表`',
     '`先点上面的按钮拉清单`', None),
    # 思考档位说明
    ('`不使用额外思考模式。`',
     '`不多想，直接答。`', None),
    ('`日常思考与回答共用的应用上限为 2048 tokens；思考可能占用回答额度。上限不代表实际用量，较高档位可能增加等待与用量。`',
     '`想得越深，等得越久，也越费额度。`', None),
]


def main():
    arg = sys.argv[1] if len(sys.argv) > 1 else ''
    s = open(TARGET, encoding='utf-8').read()

    if arg == '--check':
        print('[mark]', s.count(MARK))
        bad = 0
        for old, new, want in PAIRS:
            n = len(re.findall(loose(old), s))
            ok = (n == 1) if want is None else (n == want)
            if not ok:
                bad += 1
            print('  %s hits=%-2d  %s' % ('OK ' if ok else '!! ', n, old[:44]))
        print('[check] bad=', bad)
        return

    if arg == '--revert':
        if not os.path.exists(BAK):
            print('[no-backup]')
            return
        shutil.copyfile(BAK, TARGET)
        print('[reverted] len=', len(open(TARGET, encoding='utf-8').read()))
        return

    if s.count(MARK):
        print('[already]')
        return

    if not os.path.exists(BAK):
        shutil.copyfile(TARGET, BAK)

    out = s
    applied, skipped = [], []
    for old, new, want in PAIRS:
        hits = list(re.finditer(loose(old), out))
        n = len(hits)
        ok = (n == 1) if want is None else (n == want)
        if not ok:
            skipped.append((old, 'hits=%d' % n))
            continue
        for m in reversed(hits):
            out = out[:m.start()] + esc(new) + out[m.end():]
        applied.append(old)

    out = MARK + '\n' + out
    open(TARGET, 'w', encoding='utf-8', newline='').write(out)
    print('[applied]', len(applied), '/', len(PAIRS), 'len', len(s), '->', len(out))
    for o, why in skipped:
        print('  SKIP', why, o[:50])

    assert out.count(MARK) == 1, 'mark'
    for old, new, want in PAIRS:
        left = len(re.findall(loose(old), out))
        if left:
            print('  LEFT', left, old[:40])


main()
