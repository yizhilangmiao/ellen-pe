# -*- coding: utf-8 -*-
"""精确改字：在 work/ 里的某个已有文件里替换一段文字（小白最常用的操作）。

为什么不让你手动打开文件改：
  APK 里的前端文件是压缩过的单行大文件（1.8 MB 一行），
  用记事本改会顺手把编码/换行改坏，回包后白屏。

用法（在 创作版\\ 目录下）：
    python _edit_text.py --grep "一段文字"
        ↑ 在 work\\assets\\public 全部前端文件里搜，告诉你这段文字在哪几个文件、各几次
    python _edit_text.py --file assets/public/index.html --old "旧文字" --new "新文字"
        ↑ 只检查：告诉我命中几次，不写盘
    python _edit_text.py --file assets/public/index.html --old "旧文字" --new "新文字" --apply
        ↑ 真改，自动备份成 .bak-edit
    python _edit_text.py --file assets/public/index.html --revert
        ↑ 从 .bak-edit 还原

规则：
    --file 相对 work\\ 的路径，用 / 分隔（例：assets/public/index.html）
    命中数必须恰好等于 --count（默认 1），否则拒绝写盘 —— 防止改到不相干的地方。
    要一次改多处同样的文字，加 --count 0（全部替换）。
    按字节替换，不动编码和换行，所以改完还能原样回包。
"""
import argparse
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.path.join(HERE, "work")
SCAN_DIRS = [os.path.join(WORK, "assets", "public")]
SCAN_EXT = (".js", ".html", ".css", ".json", ".txt", ".md")
# 这些目录里是模型词表 / wasm / 第三方库，不是界面文字，搜出来的命中只会误导
SKIP_DIRS = {"local-embeddings", "local-asr", "local-call-asr", "models", "wasm", "vendor"}


def do_grep(needle):
    nb = needle.encode("utf-8")
    hit_any = False
    for d in SCAN_DIRS:
        if not os.path.isdir(d):
            sys.exit("缺目录: " + d + "\n  先跑 python _dev_extract.py --clean --apk <基准APK>")
        for root, _dirs, files in os.walk(d):
            _dirs[:] = [x for x in _dirs if x.lower() not in SKIP_DIRS]
            for fn in files:
                if not fn.lower().endswith(SCAN_EXT):
                    continue
                p = os.path.join(root, fn)
                try:
                    with open(p, "rb") as f:
                        data = f.read()
                except OSError:
                    continue
                n = data.count(nb)
                if n:
                    hit_any = True
                    rel = os.path.relpath(p, WORK).replace(os.sep, "/")
                    print("  %-52s %d 次" % (rel, n))
    if not hit_any:
        print("  没有文件包含这段文字。逐字核对（标点/空格/全半角），或用更短的一段试。")
        return 2
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", default=None, help="相对 work\\ 的路径，用 / 分隔")
    ap.add_argument("--old", default=None, help="要被替换掉的原文字")
    ap.add_argument("--new", default="", help="替换成什么")
    ap.add_argument("--count", type=int, default=1, help="期望命中次数，0=全部替换（默认 1）")
    ap.add_argument("--apply", action="store_true", help="真写盘（不加只检查）")
    ap.add_argument("--revert", action="store_true", help="从 .bak-edit 还原")
    ap.add_argument("--grep", default=None, help="在 work\\assets\\public 里搜这段文字")
    args = ap.parse_args()

    if args.grep:
        print("搜索: %r" % args.grep)
        return do_grep(args.grep)

    if not args.file:
        sys.exit("缺 --file（或者用 --grep 先搜）")

    rel = args.file.replace("/", os.sep).replace("\\", os.sep)
    path = os.path.join(WORK, rel)
    bak = path + ".bak-edit"

    if not os.path.isfile(path):
        sys.exit("找不到文件: " + path + "\n  先跑 python _dev_extract.py --clean --apk <基准APK>")

    if args.revert:
        if not os.path.isfile(bak):
            sys.exit("没有备份可还原: " + bak)
        with open(bak, "rb") as f:
            data = f.read()
        with open(path, "wb") as f:
            f.write(data)
        os.remove(bak)
        print("[已还原] %s  (%d bytes)" % (args.file, len(data)))
        return 0

    if args.old is None:
        sys.exit("要么给 --old，要么用 --revert")

    with open(path, "rb") as f:
        data = f.read()
    old = args.old.encode("utf-8")
    new = args.new.encode("utf-8")

    hits = data.count(old)
    print("文件      : %s  %d bytes" % (args.file, len(data)))
    print("原文字    : %r" % args.old)
    print("命中次数  : %d  (要求 %s)" % (hits, args.count if args.count else "全部替换"))

    if hits == 0:
        print("")
        print("!! 一个字都没命中。先跑：python _edit_text.py --grep \"你想改的原文\"")
        return 2
    if args.count and hits != args.count:
        print("")
        print("!! 命中次数不符，拒绝写盘（避免改到不该改的地方）。")
        print("   确认要全部替换就加 --count 0；确认只改一处就先缩小 --old 的范围。")
        return 3

    if not args.apply:
        print("")
        print("以上是检查结果，还没写盘。确认无误后加 --apply 执行。")
        return 0

    if args.count:
        out = data.replace(old, new, 1)
    else:
        out = data.replace(old, new)
    if os.path.isfile(bak):
        os.remove(bak)
    with open(bak, "wb") as f:
        f.write(data)
    with open(path, "wb") as f:
        f.write(out)
    print("")
    print("[已改] %d 处，%d -> %d bytes" % (hits, len(data), len(out)))
    print("[备份] " + os.path.basename(bak))
    print("")
    print("下一步：")
    print("  python _dev_pack.py                 # 回包")
    print("  pwsh -File _dev_sign.ps1            # 签名")
    return 0


if __name__ == "__main__":
    sys.exit(main())
