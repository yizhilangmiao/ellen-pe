# -*- coding: utf-8 -*-
"""后台 runOnce 前先 resume()，清掉卡住的 automatic 任务锁"""
import io,sys,os
T=os.path.join('work','assets','public','assets','autonomy-cavPmG33.js')
BAK=T+'.bak-bgresume'
OLD="let Q=await Z.automation.runOnce({mode:`background`,signal:h,deadlineAt:E()+24e4});"
NEW="try{await Z.automation.resume()}catch(e){}let Q=await Z.automation.runOnce({mode:`background`,signal:h,deadlineAt:E()+24e4});"
m=sys.argv[1] if len(sys.argv)>1 else '--check'
s=io.open(T,encoding='utf-8').read()
if m=='--revert':
    if os.path.exists(BAK): io.open(T,'w',encoding='utf-8').write(io.open(BAK,encoding='utf-8').read());print('已还原')
    else: print('无备份')
else:
    c=s.count(OLD); print('命中',c)
    if c!=1: print('!! 不唯一')
    elif m=='--check': print('OK')
    else:
        if not os.path.exists(BAK): io.open(BAK,'w',encoding='utf-8').write(s)
        io.open(T,'w',encoding='utf-8').write(s.replace(OLD,NEW)); print('已打')
