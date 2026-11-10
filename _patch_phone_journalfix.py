# -*- coding: utf-8 -*-
r"""修手记三件事。

老大 11-02 反馈
    1. 检查自动整理手记是否关思考（已在：ellen-journal-nothink + journal-budget 8000）
    2. 「手记保存结果尚未确认，请核对已有记录，不要重复整理。」看不懂，要知道去哪确认
    3. 一天还没过完就提示这种话很怪，应该写「今天还没结束，每天艾莲会整理的」

真因（service-DGjhUELY.js）
    function tb({ ..., journalTimeoutMs: d2 = 24e4, journalReadTimeoutMs: f2 = 15e3,
                  journalCommitTimeoutMs: p2 = 3e4, journalSettleTimeoutMs: m2 = 5e3 } = {}) {
    保存手记只有 **30 秒** 预算（`journalCommitTimeoutMs = 3e4`），超时后：
      Ga(A3, { signal: o3, timeoutMs: p2, code: `UNKNOWN_COMMIT`,
               message: `手记保存结果尚未确认，请核对已有记录，不要重复整理。`,
               onTimeout: (e9) => i3.controller.abort(e9) })
    `onTimeout` 直接 **abort** 掉保存事务 —— 所以不是「等不到确认」，是**保存被掐断**，
    于是手记确实没写进去（真机上手记列表就是空的「还没有记录」）。

改法（三处，标记 /* ellen-journal-fix */）
    A. service: journalCommitTimeoutMs 3e4 → 15e4（30 秒 → 150 秒），给它足够时间落库
    B. service: UNKNOWN_COMMIT 的 message 改成用户能懂、并指明去哪看
    C. main:   手记页提示语「可手动提前整理或更新这一天；…」补上「今天还没结束」的说法

用法
    python _patch_phone_journalfix.py --check
    python _patch_phone_journalfix.py
    python _patch_phone_journalfix.py --revert
"""
import argparse
import io
import os
import shutil
import sys

sys.stdout.reconfigure(encoding='utf-8')

HERE = os.path.dirname(os.path.abspath(__file__))
PUB = os.path.join(HERE, 'work', 'assets', 'public', 'assets')
SVC = os.path.join(PUB, 'service-DGjhUELY.js')
MAIN = os.path.join(PUB, 'main-CFFhpb4h.js')
MARK = '/* ellen-journal-fix */'


def esc(s):
    return ''.join(ch if ord(ch) < 128 else '\\u%04X' % ord(ch) for ch in s)


def load(p):
    return io.open(p, encoding='utf-8', errors='surrogateescape').read()


def save(p, s):
    io.open(p, 'w', encoding='utf-8', errors='surrogateescape', newline='').write(s)


# ---------- A: 保存超时 30 秒 -> 150 秒 ----------
A_OLD = 'journalCommitTimeoutMs: p2 = 3e4'
A_NEW = 'journalCommitTimeoutMs: p2 = 15e4 ' + MARK

# ---------- B: UNKNOWN_COMMIT 文案 ----------
B_OLD = 'message: `%s`' % esc('手记保存结果尚未确认，请核对已有记录，不要重复整理。')
B_NEW = 'message: `%s`' % esc('这天的手记还没存完，可能已经在写了。等一分钟再回到这一页看看；'
                             '如果看到已经写好的内容，就别再点整理了。')

# ---------- C: 手记页提示语 ----------
C_OLD = '`%s`' % esc('可手动提前整理或更新这一天；没有新内容时只核对，不重复请求模型。')
C_NEW = '`%s`' % esc('今天还没结束也没关系，她每天都会自己整理这一天。'
                    '想提前看看就点上面的按钮；已经写过再点只会核对，不会重复问模型。')


def report(tag, s, old, new):
    print('  %-6s old=%d new=%d' % (tag, s.count(old), s.count(new)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--check', action='store_true')
    ap.add_argument('--revert', action='store_true')
    a = ap.parse_args()

    if a.revert:
        for p in (SVC, MAIN):
            bak = p + '.bak-journalfix'
            if os.path.exists(bak):
                shutil.copyfile(bak, p)
                print('[revert] %s' % os.path.basename(p))
        return 0

    svc, mn = load(SVC), load(MAIN)
    done = svc.count(MARK) >= 2 and mn.count(C_NEW) == 1

    if a.check:
        print('[%s]' % ('already' if done else 'pending'))
        report('A', svc, A_OLD, A_NEW)
        report('B', svc, B_OLD, B_NEW)
        report('C', mn, C_OLD, C_NEW)
        print('  nothink=%d  budget=%d' % (svc.count('ellen-journal-nothink'), svc.count('ellen-journal-budget')))
        return 0

    if done:
        print('[already]')
        return 0

    for tag, s, old in (('A', svc, A_OLD), ('B', svc, B_OLD), ('C', mn, C_OLD)):
        assert s.count(old) == 1, '%s 锚点命中 %d 次，不敢改' % (tag, s.count(old))

    if not os.path.exists(SVC + '.bak-journalfix'):
        shutil.copyfile(SVC, SVC + '.bak-journalfix')
    if not os.path.exists(MAIN + '.bak-journalfix'):
        shutil.copyfile(MAIN, MAIN + '.bak-journalfix')

    l0, m0 = len(svc), len(mn)
    svc = svc.replace(A_OLD, A_NEW, 1).replace(B_OLD, B_NEW, 1)
    mn = mn.replace(C_OLD, C_NEW, 1)
    save(SVC, svc)
    save(MAIN, mn)

    s2, m2 = load(SVC), load(MAIN)
    assert s2.count(A_NEW) == 1 and s2.count(A_OLD) == 0
    assert s2.count(B_NEW) == 1 and s2.count(B_OLD) == 0
    assert m2.count(C_NEW) == 1 and m2.count(C_OLD) == 0
    assert s2.count('ellen-journal-nothink') == 1, '关思考补丁丢了'
    assert s2.count('maxTokens: 8e3') == 1, 'journal 预算补丁丢了'

    print('[applied]')
    print('  service %d -> %d  (%+d)' % (l0, len(s2), len(s2) - l0))
    print('  main    %d -> %d  (%+d)' % (m0, len(m2), len(m2) - m0))
    print('  关思考仍在=%d  journal预算8000仍在=%d' % (s2.count('ellen-journal-nothink'), s2.count('maxTokens: 8e3')))
    return 0


sys.exit(main())
