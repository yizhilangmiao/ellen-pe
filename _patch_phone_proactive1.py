# -*- coding: utf-8 -*-
"""
手机版主动消息 v2 · P0+P1 补丁
在现役产物 (work/assets/public) 上做三处最小改动：

  1. service chunk: ![3, 4].includes(...followupLimit) × 2  →  放宽为 [0,1,2,3,4]
     （不放宽的话，任何非 3/4 的档位都会让读盘 throw，全停摆）
  2. service chunk: 抢占前插本地预筛 __ELLEN_PROACTIVE_GATE__
  3. index.html: 在 ellen-startup-opening.js 之前加载 ellen-proactive.js

用法：
  python _patch_phone_proactive1.py --check    # 只检查，不写
  python _patch_phone_proactive1.py            # 应用
  python _patch_phone_proactive1.py --revert   # 回滚
"""
import sys, os, io, json, shutil

ROOT = os.path.dirname(os.path.abspath(__file__))
PUB = os.path.join(ROOT, "work", "assets", "public")
SERVICE = os.path.join(PUB, "assets", "service-DGjhUELY.js")
INDEX = os.path.join(PUB, "index.html")
BAK_SUFFIX = ".bak-proactive1"

# ---------- 补丁定义 ----------
# (描述, 原文, 替换文, 期望命中次数)
SERVICE_PATCHES = [
    (
        "放宽 contactPlan.followupLimit 校验",
        "![3, 4].includes(i2.followupLimit)",
        "![0,1,2,3,4].includes(i2.followupLimit)",
        1,
    ),
    (
        "放宽 waiting.followupLimit 校验",
        "![3, 4].includes(a2.followupLimit)",
        "![0,1,2,3,4].includes(a2.followupLimit)",
        1,
    ),
    (
        "抢占前插本地预筛",
        "if (l2 || c3 < f2 || !Ry(t3)) return { status: `unavailable` };\n"
        "    let u3, p3 = await m2(",
        "if (l2 || c3 < f2 || !Ry(t3)) return { status: `unavailable` };\n"
        "    if (globalThis.__ELLEN_PROACTIVE_GATE__ && !globalThis.__ELLEN_PROACTIVE_GATE__(t3, c3)) return { status: `gate-skip` };\n"
        "    let u3, p3 = await m2(",
        1,
    ),
    (
        "确认要发时记一次额度",
        "let p4 = await h2(g3, _3, (e9) => il(e9, y2, f3,",
        "globalThis.__ellenProactiveCommit__ && globalThis.__ellenProactiveCommit__();\n"
        "      let p4 = await h2(g3, _3, (e9) => il(e9, y2, f3,",
        1,
    ),
]

INDEX_OLD = '<script src="./ellen-startup-opening.js">'
INDEX_NEW = '<script src="./ellen-proactive.js"></script><script src="./ellen-startup-opening.js">'


def read(path):
    with io.open(path, "r", encoding="utf-8", newline="") as f:
        return f.read()


def write(path, s):
    with io.open(path, "w", encoding="utf-8", newline="") as f:
        f.write(s)


def backup(path):
    b = path + BAK_SUFFIX
    if not os.path.exists(b):
        shutil.copy2(path, b)
        return b, True
    return b, False


def restore(path):
    b = path + BAK_SUFFIX
    if not os.path.exists(b):
        return False
    shutil.copy2(b, path)
    return True


def main():
    check = "--check" in sys.argv
    revert = "--revert" in sys.argv

    for p in (SERVICE, INDEX):
        if not os.path.exists(p):
            print("[FATAL] 找不到 %s" % p)
            return 2

    if revert:
        n = 0
        for p in (SERVICE, INDEX):
            if restore(p):
                n += 1
                print("[OK] 已回滚 %s" % os.path.basename(p))
        if n == 0:
            print("[MISS] 没有备份可回滚")
        return 0

    svc = read(SERVICE)
    idx = read(INDEX)
    problems = []

    print("=== service chunk (%d B) ===" % len(svc))
    for desc, old, new, want in SERVICE_PATCHES:
        cnt = svc.count(old)
        state = "已应用" if svc.count(new) > 0 and cnt == 0 else ("待应用" if cnt == want else "异常")
        print("  [%s] %s  命中 %d/%d" % (state, desc, cnt, want))
        if cnt != want and svc.count(new) == 0:
            problems.append((desc, cnt, want))
        elif cnt != want and svc.count(new) > 0:
            print("       （已处于已应用状态）")

    print("=== index.html (%d B) ===" % len(idx))
    c_loaded = idx.count("ellen-proactive.js")
    c_old = idx.count(INDEX_OLD)
    if c_loaded == 1 and c_old == 1:
        print("  [已应用] 加载 ellen-proactive.js")
    elif c_loaded == 0 and c_old == 1:
        print("  [待应用] 加载 ellen-proactive.js  命中 1/1")
    else:
        print("  [异常] 加载 ellen-proactive.js  已加载 %d 次 / 旧锚点 %d" % (c_loaded, c_old))
        problems.append(("index.html 锚点", c_old, 1))

    if check:
        print("\n--check 结束。%s" % ("全部就绪" if not problems else "有 %d 处需要处理" % len(problems)))
        return 0 if not problems else 1

    if problems:
        print("\n[ABORT] 有 %d 处锚点不匹配，未写入任何文件。" % len(problems))
        for d, c, w in problems:
            print("   - %s: 命中 %d，期望 %d" % (d, c, w))
        return 1

    # 备份
    for p in (SERVICE, INDEX):
        b, created = backup(p)
        print("[BAK] %s -> %s%s" % (os.path.basename(p), os.path.basename(b), "" if created else "（已存在，保留）"))

    # 应用
    for desc, old, new, want in SERVICE_PATCHES:
        if svc.count(old) == want:
            svc = svc.replace(old, new)
            print("[PATCH] %s" % desc)
        else:
            print("[SKIP ] %s（已应用）" % desc)

    if idx.count(INDEX_OLD) == 1:
        idx = idx.replace(INDEX_OLD, INDEX_NEW)
        print("[PATCH] index.html 加载 ellen-proactive.js")

    write(SERVICE, svc)
    write(INDEX, idx)

    # 自证
    print("\n=== 写入后自证 ===")
    svc2 = read(SERVICE)
    idx2 = read(INDEX)
    ok = True
    for desc, old, new, want in SERVICE_PATCHES:
        if svc2.count(new) < 1:
            print("  [FAIL] %s 未生效" % desc); ok = False
        else:
            print("  [OK] %s" % desc)
    if idx2.count("ellen-proactive.js") != 1:
        print("  [FAIL] index.html 未生效"); ok = False
    else:
        print("  [OK] index.html")
    print("  service %d B -> %d B | index %d B -> %d B" % (len(read(SERVICE + BAK_SUFFIX)), len(svc2),
                                                          len(read(INDEX + BAK_SUFFIX)), len(idx2)))
    print("\n%s" % ("全部完成" if ok else "有失败项，用 --revert 回滚"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
