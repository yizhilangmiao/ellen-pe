# -*- coding: utf-8 -*-
"""后台 runOnce 返回值写进 localStorage，前台可读（同 origin 共享）"""
import io,sys,os
T=os.path.join('work','assets','public','assets','autonomy-cavPmG33.js')
BAK=T+'.bak-bgdbg'
OLD="let Q=await Z.automation.runOnce({mode:`background`,signal:h,deadlineAt:E()+24e4}),$="
NEW="let Q=await Z.automation.runOnce({mode:`background`,signal:h,deadlineAt:E()+24e4});try{localStorage.setItem(`__ellenBgDbg`,JSON.stringify({st:Q&&Q.status,kind:Q&&Q.kind,nextAt:Q&&Q.nextAt,at:Date.now()}))}catch(e){}let $="
m=sys.argv[1] if len(sys.argv)>1 else '--check'
s=io.open(T,encoding='utf-8').read()
if m=='--revert':
    if os.path.exists(BAK):
        io.open(T,'w',encoding='utf-8').write(io.open(BAK,encoding='utf-8').read());print('已还原')
    else: print('无备份')
else:
    c=s.count(OLD); print('命中',c)
    if c!=1: print('!! 不唯一')
    elif m=='--check': print('OK')
    else:
        if not os.path.exists(BAK): io.open(BAK,'w',encoding='utf-8').write(s)
        io.open(T,'w',encoding='utf-8').write(s.replace(OLD,NEW)); print('已打')
