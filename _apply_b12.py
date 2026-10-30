# -*- coding: utf-8 -*-
"""
把 b12 适配链应用到「手机创作版 work」（该 work 已含记忆优化补丁 1/2/3/4）。

不改目录结构，只在 work\assets\public\ 上就地改造：
  1. 备份原样 -> _backup_mem\
  2. prep          SOURCE_FIXES / dvh->vh / fix_layout / 未实名气泡
  3. downgrade     esbuild --target=chrome64
  4. polyfill      每个 js 首部注入 ES5 polyfill
  5. uuid          crypto.randomUUID（业务层硬断言）
  6. diagnose      index.html 内联 CSS + DIAG + 自动重载
  7. 结果写回 work\assets\public\

跑完再走 _dev_pack.py -> _dev_sign.ps1。
"""
import importlib.util
import io
import os
import shutil
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8")

HERE = r"E:\ailian\艾莲手机版\创作版"
PUB = os.path.join(HERE, "work", "assets", "public")
BAK = os.path.join(HERE, "_backup_mem")
TMP = os.path.join(HERE, "_b12", "web")
OUT = os.path.join(HERE, "_b12", "web_out")
V120 = r"E:\ailian\_临时\v120build"
ESBUILD = r"E:\ailian\工具\esbuild\esbuild.exe"
BUILD_TAG = "0.1.20-b15-mem (2026-10-29T23:21)"

SRC_JS_EXT = (".js", ".mjs")


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def hr(t):
    print()
    print("=" * 66)
    print(t)
    print("=" * 66)


def main():
    if not os.path.isdir(PUB):
        print("[STOP] 找不到 work 的 assets/public:", PUB)
        return 1

    # ---------- 1. 备份 ----------
    hr("1/7 备份 work\\assets\\public -> _backup_mem")
    # 防二次降级：如果 PUB 已经是改造过的（有 __ellen_uuid_patched），
    # 说明上次已经跑过一遍；此时不能拿它当备份源，否则备份被污染、
    # 重跑等于在降级产物上再降一次。
    _probe = os.path.join(PUB, "assets", "main-CFFhpb4h.js")
    _already = False
    if os.path.isfile(_probe):
        try:
            _t = io.open(_probe, encoding="utf-8", errors="surrogateescape").read()
            _already = ("__ellen_uuid_patched" in _t) or ("ellen-polyfill" in _t)
        except Exception:
            pass
    if _already:
        if not os.path.isdir(BAK):
            print("[STOP] PUB 已是改造产物，但找不到 _backup_mem 原始备份，无法回滚。")
            return 1
        print("[WARN] PUB 已是改造产物（含 polyfill/uuid），先从 _backup_mem 恢复，不再覆盖备份")
        shutil.rmtree(PUB)
        shutil.copytree(BAK, PUB)
    else:
        if os.path.isdir(BAK):
            shutil.rmtree(BAK)
        shutil.copytree(PUB, BAK)
    n = sum(len(f) for _, _, f in os.walk(BAK))
    print("原始备份 %d 个文件" % n)

    # ---------- 2. 暂存副本 ----------
    hr("2/7 复制到 _b12\\web 作为改造输入")
    if os.path.isdir(os.path.join(HERE, "_b12")):
        shutil.rmtree(os.path.join(HERE, "_b12"))
    shutil.copytree(PUB, TMP)
    print("已复制")

    # ---------- 3. prep：源码级修正 ----------
    hr("3/7 prep  SOURCE_FIXES / dvh->vh / fix_layout / 气泡补丁")
    prep = load("prep", os.path.join(V120, "_step_prep.py"))
    prep.WEB = TMP
    prep.apply_source_fixes()
    prep.fix_css_units()
    prep.fix_inset()
    prep.fix_layout()
    prep.add_startup_probe()
    prep.inject_static_css()
    prep.add_diag_entry()
    # 气泡补丁：prep 的 main 里做，这里单独跑同一段逻辑
    mpath = os.path.join(TMP, "assets", "main-CFFhpb4h.js")
    if os.path.exists(mpath):
        with io.open(mpath, "r", encoding="utf-8", newline="") as f:
            s = f.read()
        if "ellen-realname-bubble" in s:
            print("[skip] 气泡补丁已存在")
        elif prep.BUBBLE_OLD in s:
            s = s.replace(prep.BUBBLE_OLD, prep.BUBBLE_NEW, 1)
            with io.open(mpath, "w", encoding="utf-8", newline="") as f:
                f.write(s)
            print("[OK ] 气泡补丁 main-CFFhpb4h.js ->%d" % len(s))
        else:
            print("[WARN] 气泡锚点没匹配，跳过（不改）")

    # ---------- 4. 降级 ----------
    hr("4/7 downgrade  esbuild --target=chrome64")
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    ok, fail, empty = [], [], []
    for root, _, files in os.walk(TMP):
        for fn in files:
            src = os.path.join(root, fn)
            rel = os.path.relpath(src, TMP)
            dst = os.path.join(OUT, rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            if not fn.endswith(SRC_JS_EXT):
                shutil.copy2(src, dst)
                continue
            if os.path.getsize(src) == 0:
                shutil.copy2(src, dst)
                empty.append(rel)
                continue
            r = subprocess.run(
                [ESBUILD, src, "--target=chrome64", "--format=esm",
                 "--outfile=" + dst, "--log-level=error", "--allow-overwrite"],
                capture_output=True, text=True, encoding="utf-8", errors="replace")
            if r.returncode == 0 and os.path.exists(dst) and os.path.getsize(dst) > 0:
                ok.append((rel, os.path.getsize(src), os.path.getsize(dst)))
            else:
                fail.append((rel, (r.stderr or "").strip()[:200]))
                shutil.copy2(src, dst)
    for rel, a, b in sorted(ok, key=lambda x: -x[1]):
        print("  [OK]    %-42s %9d -> %9d" % (rel, a, b))
    for rel in empty:
        print("  [EMPTY] %s" % rel)
    for rel, err in fail:
        print("  [FAIL]  %s" % rel)
        for line in err.splitlines()[:3]:
            print("           %s" % line)
    print("---- ok=%d fail=%d empty=%d ----" % (len(ok), len(fail), len(empty)))

    # ---------- 5. polyfill ----------
    hr("5/7 polyfill  每个 js 首部注入")
    pf = load("pf", os.path.join(V120, "_polyfill.py"))
    pf.ROOT = OUT
    rc = pf.main()
    if rc != 0:
        print("[STOP] polyfill 失败")
        return 1

    # ---------- 6. uuid ----------
    hr("6/7 uuid  crypto.randomUUID")
    ud = load("ud", os.path.join(V120, "_add_uuid.py"))
    ud.ROOT = OUT
    rc = ud.main()
    if rc != 0:
        print("[STOP] uuid 失败")
        return 1

    # ---------- 7. diagnose ----------
    hr("7/7 diagnose  index.html")
    dg = load("dg", os.path.join(V120, "_diagnose.py"))
    dg.INDEX = os.path.join(OUT, "index.html")
    # _diagnose.py 第 672 行 DIAG = DIAG.replace("__BUILD__", BUILD_TAG) 是模块级的，
    # import 时就用了源码里的默认值；这里再改 BUILD_TAG 已经晚了，只能替换掉那个默认值。
    _OLD_TAG = "0.1.20-b15-mem (2026-10-29T23:21)"
    dg.BUILD_TAG = BUILD_TAG
    if _OLD_TAG in dg.DIAG:
        dg.DIAG = dg.DIAG.replace(_OLD_TAG, BUILD_TAG)
        print("BUILD_TAG ->", BUILD_TAG)
    else:
        print("[WARN] DIAG 里没找到旧 BUILD_TAG，日志版本号可能不对")
    rc = dg.main()
    if rc != 0:
        print("[STOP] diagnose 失败")
        return 1

    # ---------- 写回 ----------
    hr("写回 work\\assets\\public")
    changed = 0
    for root, _, files in os.walk(OUT):
        for fn in files:
            src = os.path.join(root, fn)
            rel = os.path.relpath(src, OUT)
            dst = os.path.join(PUB, rel)
            if not os.path.exists(dst):
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.copy2(src, dst)
                changed += 1
                print("  [NEW ] %s" % rel)
                continue
            if os.path.getsize(src) != os.path.getsize(dst):
                shutil.copy2(src, dst)
                changed += 1
                print("  [DIFF] %-44s %9d -> %9d" % (rel, os.path.getsize(BAK) and os.path.getsize(os.path.join(BAK, rel)) or 0, os.path.getsize(src)))
            else:
                with io.open(src, "rb") as a, io.open(dst, "rb") as b:
                    if a.read() != b.read():
                        shutil.copy2(src, dst)
                        changed += 1
                        print("  [DIFF] %s (同大小不同内容)" % rel)
    print("写回完成，变更 %d 个文件" % changed)

    hr("校验")
    idx = os.path.join(PUB, "index.html")
    with io.open(idx, "r", encoding="utf-8", newline="") as f:
        html = f.read()
    print("index.html 大小      : %d" % len(html.encode("utf-8")))
    print("charset 位置         : %d" % html.find("charset="))
    print("ellen-diag           : %d" % html.count("ellen-diag"))
    print("ellen-static-css     : %d" % html.count("ellen-static-css"))
    print("BUILD_TAG 出现       : %d" % html.count(BUILD_TAG))
    print("自动重载 __wt        : %d" % html.count("__wt"))
    chk = [("main-CFFhpb4h.js", ["??=", "||=", "&&=", "__ellen_uuid_patched", "ellen-polyfill"]),
           ("persona-CBp1pExX.js", ["??=", "((_a) =>", "__ellen_uuid_patched"]),
           ("service-DGjhUELY.js", ["??=", "__ellen_uuid_patched"]),
           ("storage-worker-C5hDp6Bk.js", ["??=", "__ellen_uuid_patched"])]
    for fn, keys in chk:
        p = os.path.join(PUB, "assets", fn)
        if not os.path.exists(p):
            print("  [MISS] %s" % fn)
            continue
        with io.open(p, "r", encoding="utf-8", newline="") as f:
            s = f.read()
        print("  %-28s size=%8d  %s" % (fn, len(s), "  ".join("%s=%d" % (k, s.count(k)) for k in keys)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
