# -*- coding: utf-8 -*-
"""手机版记忆·检索 + 召回

现状（真机实测）：每次聊天召回的永远是同一批 7 条记忆（recalls 计数各 23 次），
与当前话题无关。原因全在 Vl() 里：

  · limit 默认 8 —— 记忆一多就永远只看前 8 条
  · 「最近 3 轮用过」的折扣只有 0.65 —— 压制不住同批霸占
  · 时间邻近扩展只有 15 分钟 —— 同一天的事连不起来
  · 融合池上限 48 —— 候选面窄

改法：
  检索：limit 8 -> 12；最近用过的折扣 0.65 -> 0.45
  召回：时间邻近窗口 15 分钟 -> 6 小时；邻近池 12 -> 24；融合池 48 -> 96
"""
import io
import shutil
import sys

SRC = r'E:\ailian\艾莲手机版\创作版\work\assets\public\assets\service-DGjhUELY.js'
BAK = SRC + '.bak-memrecall'
MARK = '/* ellen-mem-recall */'

PAIRS = [
    # 1) 检索：默认额度 8 -> 12
    ('function Vl(e8, t2, { limit: n2 = 8, includeDormant: r2 = false',
     'function Vl(e8, t2, { limit: n2 = 12, includeDormant: r2 = false ' + MARK, 1),
    # 2) 检索：最近用过折扣 0.65 -> 0.45
    ('(i2.has(e9.id) && a2 - i2.get(e9.id) < 3 && !d2 ? 0.65 : 1)',
     '(i2.has(e9.id) && a2 - i2.get(e9.id) < 3 && !d2 ? 0.45 : 1)', 1),
    # 3) 召回：时间邻近窗口 15 分钟 -> 6 小时
    ('if (Math.abs(_t1 - _t0) <= 9e5) _out.push({ doc: _m2, score: 1 });',
     'if (Math.abs(_t1 - _t0) <= 216e5) _out.push({ doc: _m2, score: 1 }); ' + MARK, 1),
    # 4) 召回：邻近池 12 -> 24（两处出现的那个 slice 在融合里）
    ('z2.slice(0, 24), nl2.slice(0, 12)], { limit: 48 })',
     'z2.slice(0, 24), nl2.slice(0, 24)], { limit: 96 })', 1),
]


def main():
    s = io.open(SRC, encoding='utf-8').read()
    mode = sys.argv[1] if len(sys.argv) > 1 else ''

    if mode == '--check':
        print('mark', s.count(MARK))
        for old, new, _ in PAIRS:
            print('  old=%d new=%d  %s' % (s.count(old), s.count(new), old[:52]))
        return

    if mode == '--revert':
        shutil.copyfile(BAK, SRC)
        t = io.open(SRC, encoding='utf-8').read()
        print('[revert] len', len(t), 'mark', t.count(MARK))
        return

    if MARK in s:
        print('[already]')
        return

    bad = [(o[:40], s.count(o)) for o, _, want in PAIRS if s.count(o) != want]
    if bad:
        print('[fail] 锚点不匹配:', bad)
        return

    before = len(s)
    shutil.copyfile(SRC, BAK)
    for old, new, _ in PAIRS:
        s = s.replace(old, new, 1)
    io.open(SRC, 'w', encoding='utf-8', newline='').write(s)

    print('[applied] %d -> %d  delta %+d' % (before, len(s), len(s) - before))
    chk = io.open(SRC, encoding='utf-8').read()
    assert chk.count(MARK) == 2, 'mark=%d' % chk.count(MARK)
    for old, new, _ in PAIRS:
        assert chk.count(old) == 0, 'old still there: %s' % old[:40]
    assert 'limit: n2 = 12' in chk and '? 0.45 : 1)' in chk
    assert '216e5' in chk and '{ limit: 96 }' in chk
    print('  [self-check] ok')


main()
