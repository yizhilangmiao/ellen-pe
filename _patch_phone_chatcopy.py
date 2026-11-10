# -*- coding: utf-8 -*-
"""聊天模型配置向导：把黑话改成小白能看懂的话（只改文案，不动结构）。

源文件里中文既可能是 \\uXXXX 也可能出现 \\xB7 这类两位十六进制，
所以匹配走「宽松正则」：非 ASCII 一律 (?:\\uXXXX|\\uXXXX小写|\\xNN|字面) 多选一，ASCII 原样。
替换统一写成 \\uXXXX。

每条 old 都带足上下文代码，保证在整文件里唯一命中，否则跳过不动。
"""
import os
import re
import shutil
import sys

ROOT = r'E:\ailian\艾莲手机版\创作版'
TARGET = os.path.join(ROOT, 'work', 'assets', 'public', 'assets', 'main-CFFhpb4h.js')
BAK = TARGET + '.bak-chatcopy'
MARK = '/* ellen-chat-copy */'


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
    # 三步标题
    ('labels: [`填写 Key`, `确认并保存服务`, `选择并使用模型`]',
     'labels: [`把 Key 粘进来`, `选平台并存下`, `挑一个模型用上`]'),
    # 三步说明
    ('`已有 Key 直接粘贴；还没有的话，先按下面的引导创建。`',
     '`有 Key 就直接粘进来。还没有的话，下面教你去哪领。`'),
    ('`确认拿 Key 的平台与购买类型，地址会相应填写，核对后保存。`',
     '`选你从哪家买的 Key，地址会自己填好，点保存就行。`'),
    ('`先获取模型列表，再选择使用；平台没有列表时，也可以手填模型 ID。`',
     '`点一下拉个清单，挑一个用上。拉不到就在下面自己填。`'),

    # 顶部当前模型卡片
    ('t2(`small`, `el-settings-eyebrow`, `与你对话的模型`)',
     't2(`small`, `el-settings-eyebrow`, `现在用的是`)'),

    # 第一步
    ('K2(`apiKey`, `API Key`, `password`, U2)',
     'K2(`apiKey`, `把 Key 粘在这里`, `password`, U2)'),

    # 第二步
    ('K2(`provider`, `模型厂商`, `select`, ee2)',
     'K2(`provider`, `Key 是从哪家买的`, `select`, ee2)'),
    ('te2(G2.provider, Tf, `请选择拿 Key 的平台`)',
     'te2(G2.provider, Tf, `点这里选平台`)'),
    ('K2(`serviceKind`, `购买类型`, `select`, ee2)',
     'K2(`serviceKind`, `买的是哪一种`, `select`, ee2)'),
    ('K2(`baseUrl`, `API 服务地址`, `url`, ie2)',
     'K2(`baseUrl`, `服务器地址`, `url`, ie2)'),
    ('let { node: ie2, heading: ae2 } = $u(t2, `服务地址`);',
     'let { node: ie2, heading: ae2 } = $u(t2, `服务器地址`);'),
    ('n2(`保存服务配置`, `shield`', 'n2(`保存，下一步`, `shield`'),
    ('`只保存服务和 Key；选择模型后才切换当前聊天配置。`',
     '`这一步只是把 Key 存下来，还不会换掉现在的模型。`'),

    # 第三步
    ('n2(`获取聊天模型列表`, `grid`', 'n2(`拉取模型清单`, `grid`'),
    ('`也可以在下面直接填写模型 ID。`',
     '`拉不到清单，就在下面自己填。`'),
    ('K2(`modelChoice`, `聊天模型列表`, `select`, W2)',
     'K2(`modelChoice`, `能用的模型`, `select`, W2)'),
    ('K2(`model`, `模型 ID`, `text`, W2)',
     'K2(`model`, `或者自己填模型 ID`, `text`, W2)'),
    ('$u(t2, `模型设置`).node', '$u(t2, `回答方式`).node'),
    ('K2(`thinking`, `思考强度`, `select`, ce2)',
     'K2(`thinking`, `想多深再回答`, `select`, ce2)'),
    ('n2(`使用这个模型`, `shield`', 'n2(`用这个模型`, `shield`'),
    ('`测试当前模型连接（可能产生费用）`',
     '`测一下能不能连上（会花一点钱）`'),

    # 管理区
    ('$u(t2, `已有配置与管理`, `el-settings-card el-onboarding-manage`).node',
     '$u(t2, `以前存过的配置`, `el-settings-card el-onboarding-manage`).node'),
    ('K2(`savedService`, `已保存服务`, `select`, pe2)',
     'K2(`savedService`, `存过的服务`, `select`, pe2)'),
    ('K2(`savedProfile`, `已保存配置`, `select`, pe2)',
     'K2(`savedProfile`, `存过的模型`, `select`, pe2)'),
    ('n2(`使用已保存配置`, `history`', 'n2(`用这一套`, `history`'),
    ('n2(`删除所选服务配置`, `close`', 'n2(`删掉这一套`, `close`'),
    ('`只删除所选服务及其模型配置，不删除聊天、记忆或声音配置；不会自动切换其他厂商。`',
     '`只删这一套 Key 和它的模型，聊天记录、记忆、声音都不动。`'),
    ('n2(`确认删除所选配置`, `close`, () => void Pe2(`remove`), `el-secondary`), n2(`保留配置`, ``',
     'n2(`确认删掉`, `close`, () => void Pe2(`remove`), `el-secondary`), n2(`算了，留着`, ``'),
    ('n2(`重新读取配置`, `refresh`', 'n2(`重新读一遍`, `refresh`'),
    ('n2(`取消当前操作`, `stop`', 'n2(`停止`, `stop`'),
]


def main():
    arg = sys.argv[1] if len(sys.argv) > 1 else ''
    s = open(TARGET, encoding='utf-8').read()

    if arg == '--check':
        print('[mark]', s.count(MARK))
        ok = bad = 0
        for old, new in PAIRS:
            n = len(re.findall(loose(old), s))
            if n == 1:
                ok += 1
            else:
                bad += 1
                print('  hits=%-2d  %s' % (n, old[:48]))
        print('[check] unique=%d / %d  bad=%d' % (ok, len(PAIRS), bad))
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
    for old, new in PAIRS:
        hits = list(re.finditer(loose(old), out))
        if len(hits) != 1:
            skipped.append((old, 'hits=%d' % len(hits)))
            continue
        m = hits[0]
        out = out[:m.start()] + esc(new) + out[m.end():]
        applied.append(old)

    out = MARK + '\n' + out
    open(TARGET, 'w', encoding='utf-8', newline='').write(out)
    print('[applied]', len(applied), '/', len(PAIRS), 'len', len(s), '->', len(out))
    for o, why in skipped:
        print('  SKIP', why, o[:60])

    # 自证
    chk = open(TARGET, encoding='utf-8').read()
    assert chk.count(MARK) == 1, 'mark'
    for o, _ in applied:
        pass
    print('[verify] mark=%d  旧词残留: API Key=%d 模型厂商=%d 思考强度=%d 填写 Key=%d' % (
        chk.count(MARK),
        len(re.findall(loose('`API Key`'), chk)),
        len(re.findall(loose('`模型厂商`'), chk)),
        len(re.findall(loose('`思考强度`'), chk)),
        len(re.findall(loose('`填写 Key`'), chk)),
    ))


main()
