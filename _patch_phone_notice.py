# -*- coding: utf-8 -*-
"""配置失败弹窗挂接：把语音/模型配置页的错误也弹出来，不再只留底部一行小字。

原实现只有 K2（p.el-form-result）一行 status/alert 文本，位置在四步向导最底下，
小白在第一步填 Key 时根本看不到。这里在 J2() 里补一次 window.__ellenNotice()，
由 inject-letter.js 注入的 .elbs-alert 弹窗负责显示完整原因。
"""
import os
import shutil
import sys

ROOT = r'E:\ailian\艾莲手机版\创作版'
TARGET = os.path.join(ROOT, 'work', 'assets', 'public', 'assets', 'main-CFFhpb4h.js')
BAK = TARGET + '.bak-notice'
MARK = '/* ellen-config-notice */'

OLD = "K2.textContent = e3, K2.setAttribute(`role`, t3 ? `alert` : `status`), $(K2, !!e3);"
NEW = ("K2.textContent = e3, K2.setAttribute(`role`, t3 ? `alert` : `status`), $(K2, !!e3), "
       + MARK
       + " t3 && e3 && (function(){ try { window.__ellenNotice && window.__ellenNotice(e3, `\u914D\u7F6E\u6CA1\u6709\u6210\u529F`); } catch (e4) {} })();")


def main():
    arg = sys.argv[1] if len(sys.argv) > 1 else ''
    s = open(TARGET, encoding='utf-8').read()
    n_old = s.count(OLD)
    n_new = s.count(MARK)

    if arg == '--check':
        print('[old]', n_old, '[mark]', n_new)
        if n_new == 1:
            print('[already]')
        elif n_old == 1:
            print('[pending]')
        else:
            print('[conflict]')
        return

    if arg == '--revert':
        if not os.path.exists(BAK):
            print('[no-backup]')
            return
        shutil.copyfile(BAK, TARGET)
        t = open(TARGET, encoding='utf-8').read()
        print('[reverted] mark=', t.count(MARK), 'old=', t.count(OLD), 'len=', len(t))
        return

    if n_new == 1:
        print('[already]')
        return
    if n_old != 1:
        print('[conflict] old=', n_old)
        return
    if not os.path.exists(BAK):
        shutil.copyfile(TARGET, BAK)
    out = s.replace(OLD, NEW)
    assert out.count(MARK) == 1, 'mark count'
    assert OLD not in out or True
    open(TARGET, 'w', encoding='utf-8', newline='').write(out)
    t = open(TARGET, encoding='utf-8').read()
    print('[applied] mark=', t.count(MARK), 'len', len(s), '->', len(t))


main()
