# -*- coding: utf-8 -*-
"""后台清理失败不再阻断主动消息
   原: if((await d({...})).failedFiles)return{status:`failed`,completed:0}
   新: try{await d({...})}catch(e){}
"""
import io, sys, os

T = os.path.join('work', 'assets', 'public', 'assets', 'autonomy-cavPmG33.js')
OLD = "if((await d({repository:e,cachePlatform:O,result:n,signal:h,check:t})).failedFiles)return{status:`failed`,completed:0}"
NEW = "try{await d({repository:e,cachePlatform:O,result:n,signal:h,check:t})}catch(e){}"
BAK = T + '.bak-bgcleanup'

def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else '--check'
    s = io.open(T, encoding='utf-8').read()
    if mode == '--revert':
        if not os.path.exists(BAK):
            print('无备份'); return
        s2 = io.open(BAK, encoding='utf-8').read()
        io.open(T, 'w', encoding='utf-8').write(s2)
        print('已还原'); return
    n = s.count(OLD)
    print('锚点命中', n)
    if n != 1:
        print('!! 命中数不为 1，中止'); return
    if mode == '--check':
        print('OK 可以打补丁'); return
    if not os.path.exists(BAK):
        io.open(BAK, 'w', encoding='utf-8').write(s)
    s = s.replace(OLD, NEW)
    io.open(T, 'w', encoding='utf-8').write(s)
    print('已打补丁，新增', len(s) - len(io.open(BAK, encoding='utf-8').read()), '字节')

main()
