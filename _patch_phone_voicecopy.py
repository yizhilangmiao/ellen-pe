# -*- coding: utf-8 -*-
"""语音模型配置向导：把黑话改成小白能看懂的话（只改文案，不动结构）。

源文件里中文既可能是 \\uXXXX 也可能出现 \\xB7 这类两位十六进制，
所以匹配走「宽松正则」：非 ASCII 一律 (?:\\uXXXX|字面) 二选一，ASCII 原样。
替换统一写成 \\uXXXX。

每条 old 都带足上下文代码，保证在整文件里唯一命中，否则跳过不动。
"""
import os
import re
import shutil
import sys

ROOT = r'E:\ailian\艾莲手机版\创作版'
TARGET = os.path.join(ROOT, 'work', 'assets', 'public', 'assets', 'main-CFFhpb4h.js')
BAK = TARGET + '.bak-voicecopy'
MARK = '/* ellen-voice-copy */'


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
    # 步骤标题（td() 渲染成「第一步：粘贴 Key」）
    ('labels: [`填写 Key`, `保存服务`, `准备声音`, `试听完成`]',
     'labels: [`粘贴 Key`, `存下 Key`, `给艾莲做声音`, `听一句`]'),
    # 步骤说明
    ('`已有 MiniMax 国内站 Key 直接粘贴；没有的话，先到下方官网创建。`',
     '`有 Key 就粘进来。没有的话，点下面的卡片去领一枚，不花钱。`'),
    ('`保存国内站 Key，服务地址已自动配置。`',
     '`把 Key 存到手机上。地址已经填好了，你不用管。`'),
    ('`准备艾莲的声音，或填写自己已经有的国内站音色 ID。`',
     '`点一下按钮，就能帮艾莲做一个声音。`'),
    ('`生成一段试听，听过后完成设置；已有完整缓存可以直接重听。`',
     '`听一句，满意就点完成。`'),
    # 第一步
    ('`这枚 Key 用于让艾莲说话；文字聊天与本机录音识别不需要这枚 Key。`',
     '`只用来让艾莲开口说话。不填也能正常打字聊天。`'),
    ('`声音 API Key`', '`把 Key 粘在这里`'),
    ('$u(t2, `还没有 Key？先去创建`).node',
     '$u(t2, `还没有 Key？点这里去领一枚`).node'),
    ('`MiniMax 国内站 · 服务地址已自动配置（minimax.cn）。`',
     '`地址已自动填好，你不用管。`'),
    ('`此站点已有 Key，留空保留`', '`已经存过 Key，留空就行`'),
    # 第二步
    ('n2(`保存语音服务`, `shield`', 'n2(`保存，下一步`, `shield`'),
    ('`先保存 Key，不会自动上传素材、复刻或合成。`',
     '`点这个不扣钱，也不会生成声音。`'),
    # 第三、四步
    ('$u(t2, `已有音色`).node', '$u(t2, `我已有音色（进阶）`).node'),
    ('`准备角色声音（可能产生费用）`', '`一键给艾莲做声音（会产生少量费用）`'),
    ('n2(`完成语音设置`, `shield`', 'n2(`做完了`, `shield`'),
    ('`暂时只用文字聊天`', '`先跳过，只用文字`'),
    ('`重听已缓存试听`', '`再听一次`'),
    ('n2(`保存已有音色`, `shield`', 'n2(`保存这个音色 ID`, `shield`'),
]


def main():
    arg = sys.argv[1] if len(sys.argv) > 1 else ''
    s = open(TARGET, encoding='utf-8').read()

    if arg == '--check':
        print('[mark]', s.count(MARK))
        for old, new in PAIRS:
            n = len(re.findall(loose(old), s))
            print('  hits=%-2d  %s' % (n, old[:44]))
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
        print('  SKIP', why, o[:50])


main()
