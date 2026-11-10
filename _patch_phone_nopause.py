# -*- coding: utf-8 -*-
"""摘掉 automationPaused 假信号：后台 run 一直被它判成 paused
   re2():  s3.automationPaused -> 0
   R2():   paused: r3.state.automationPaused === true -> !1
   z2():   t3.contact.automationPaused -> 0 (phase 与 paused 两处)
"""
import io, sys, os
T = os.path.join('work','assets','public','assets','service-DGjhUELY.js')
BAK = T + '.bak-nopause'
PAIRS = [
 ("paused: r3.state.automationPaused === true", "paused: !1"),
 ("if (j2 || s3.automationPaused || M2 && M2 !== r3 || F2()) return { status: j2 ? `closed` : s3.automationPaused ? `paused` : `busy`, nextAt: null };",
  "if (j2 || M2 && M2 !== r3 || F2()) return { status: j2 ? `closed` : `busy`, nextAt: null };"),
 ("phase: j2 ? `closed` : t3.contact.automationPaused ? `paused` : M2 || F2() ? `running` : P2.phase",
  "phase: j2 ? `closed` : M2 || F2() ? `running` : P2.phase"),
 ("paused: t3.contact.automationPaused === true", "paused: !1"),
]
def main():
    mode = sys.argv[1] if len(sys.argv)>1 else '--check'
    s = io.open(T, encoding='utf-8').read()
    if mode == '--revert':
        if os.path.exists(BAK):
            io.open(T,'w',encoding='utf-8').write(io.open(BAK,encoding='utf-8').read()); print('已还原')
        else: print('无备份')
        return
    ok = True
    for old,_ in PAIRS:
        c = s.count(old)
        print('锚点命中', c, '|', old[:52])
        if c != 1: ok = False
    if not ok: print('!! 有锚点不唯一，中止'); return
    if mode == '--check': print('OK'); return
    if not os.path.exists(BAK): io.open(BAK,'w',encoding='utf-8').write(s)
    for old,new in PAIRS: s = s.replace(old,new)
    io.open(T,'w',encoding='utf-8').write(s)
    print('已打补丁')
main()
