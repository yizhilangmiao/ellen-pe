# -*- coding: utf-8 -*-
r"""修「主动消息永久卡死」。

症状
    陪伴设置里的运行记录一直写「等待执行条件 · 下次尝试时间：2026/10/29 …」（陈旧值），
    主动消息从此再也不发。真机 IndexedDB 可见：
      · `ellen-mobile-contact-runtime` 的 `attempt.phase` 卡在 `uncertain`
      · `ellen-mobile-automatic-work-task` 里同一个 proactive-contact 任务
        每 45 秒刷一条 `AUTOMATIC_RESERVATION_INTERRUPTED` / `phase: interrupted` / `steps: []`

真因（service-DGjhUELY.js）
    function il(e8, t2, n2, { hourAt: r2, ignoreAttempt: i2 = false, settings: a2 = C } = {}) {
      if ($c(e8), !a2.enabled || !u(n2, r2) || !e8.latestUser || e8.latestUser.threadId !== t2
          || !i2 && e8.attempt) return false;
      ...
    }
    只要 `attempt` 非空就 return false。
    而发送过程抛异常时（@1298142）：
      x2 ? { ...e10, attempt: { ...e10.attempt, phase: `uncertain` } } : { ...e10, attempt: null }
    `x2` 在调用 deliver **之前**就置 true，所以「发出去了但结果没回来」会永久写死 `uncertain`。
    **uncertain 没有任何超时清理** → attempt 永远非空 → il() 永远 false
    → 再也不会触发 review（ol()）→ startedAt 也不刷新 → 死锁。
    叠加上恢复逻辑（@361070）每次启动把 `steps: []` 的任务标 interrupted，就变成 45 秒一轮的死循环。

改法
    给判定加时间窗：attempt 存在但 `startedAt` 超过 10 分钟，就当它已经失效，允许重新走 review。
    只动 `il()` 一处 + 一个 helper，不动 `ol()` / `sl()` / 恢复逻辑。
    幂等：deliver 那边有 taskKey + claimRevision 兜底，10 分钟宽限不会造成重复发。

用法
    python _patch_phone_contactstuck.py --check
    python _patch_phone_contactstuck.py
    python _patch_phone_contactstuck.py --revert
"""
import argparse
import hashlib
import io
import os
import shutil
import sys

sys.stdout.reconfigure(encoding='utf-8')

HERE = os.path.dirname(os.path.abspath(__file__))
TARGET = os.path.join(HERE, 'work', 'assets', 'public', 'assets', 'service-DGjhUELY.js')
BAK = TARGET + '.bak-contactstuck'
MARK = '/* ellen-contact-stuck */'

OLD_COND = ('if ($c(e8), !a2.enabled || !u(n2, r2) || !e8.latestUser || '
            'e8.latestUser.threadId !== t2 || !i2 && e8.attempt) return false;')

NEW_COND = ('if ($c(e8), !a2.enabled || !u(n2, r2) || !e8.latestUser || '
            'e8.latestUser.threadId !== t2 || !i2 && e8.attempt && !__ellenAttemptStale(e8.attempt, n2)) '
            'return false; ' + MARK)

HELPER = (
    '/* ellen-contact-stuck */\n'
    'function __ellenAttemptStale(a, now) {\n'
    '  if (!a) return false;\n'
    '  var t = Date.parse(a.startedAt || ``);\n'
    '  if (!isFinite(t)) return true;\n'
    '  return now - t > 6e5;\n'
    '}\n'
    'function il(e8, t2, n2,'
)

ANCHOR_FN = 'function il(e8, t2, n2,'


def load():
    return io.open(TARGET, encoding='utf-8', errors='surrogateescape').read()


def save(s):
    io.open(TARGET, 'w', encoding='utf-8', errors='surrogateescape', newline='').write(s)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--check', action='store_true')
    ap.add_argument('--revert', action='store_true')
    a = ap.parse_args()

    if a.revert:
        if not os.path.exists(BAK):
            print('[fail] 没有备份 %s' % BAK)
            return 2
        shutil.copyfile(BAK, TARGET)
        s = load()
        print('[revert] len=%d  mark=%d' % (len(s), s.count(MARK)))
        return 0

    s = load()
    has_helper = '__ellenAttemptStale' in s
    has_mark = MARK in s

    if a.check:
        print('[%s] helper=%s mark=%s len=%d' % ('already' if has_helper and has_mark else 'pending',
                                                 has_helper, has_mark, len(s)))
        print('  OLD_COND 出现 %d 次（应为 1）' % s.count(OLD_COND))
        print('  ANCHOR_FN 出现 %d 次（应为 1）' % s.count(ANCHOR_FN))
        return 0

    if has_helper and has_mark:
        print('[already] 已经打过了')
        return 0

    assert s.count(OLD_COND) == 1, 'OLD_COND 命中 %d 次，不敢改' % s.count(OLD_COND)
    assert s.count(ANCHOR_FN) == 1, 'ANCHOR_FN 命中 %d 次，不敢改' % s.count(ANCHOR_FN)

    before = len(s)
    if not os.path.exists(BAK):
        shutil.copyfile(TARGET, BAK)

    s = s.replace(OLD_COND, NEW_COND, 1)
    s = s.replace(ANCHOR_FN, HELPER, 1)
    save(s)

    # 自证
    s2 = load()
    assert s2.count(MARK) == 2, 'mark=%d' % s2.count(MARK)
    assert s2.count('function __ellenAttemptStale') == 1
    assert s2.count('__ellenAttemptStale(e8.attempt, n2)') == 1
    assert s2.count(OLD_COND) == 0, '旧条件还在'
    assert s2.count('function il(e8, t2, n2,') == 1

    print('[applied] %d -> %d  delta %+d' % (before, len(s2), len(s2) - before))
    print('  mark=2  helper=1  staleCall=1  oldCond=0')
    print('  sha256 %s' % hashlib.sha256(s2.encode('utf-8', 'surrogateescape')).hexdigest()[:16])
    return 0


sys.exit(main())
