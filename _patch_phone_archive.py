# -*- coding: utf-8 -*-
"""手机版修：资料文件（.ellenpack）清单 17 MiB 上限过低。

实测数据（真机导出包 艾莲聊天资料-2026-11-01.ellenpack 反解）：
    清单 411,645 B / 109 条记录（message 96 + attachment 11 + thread 2）
    = 约 3,776 B/条，其中 message 平均 4,355 B/条（清单里带完整正文）
    17 MiB 上限 -> 约 4,200 条聊天记录就撞 `ARCHIVE_MANIFEST_TOO_LARGE`
                  报「资料清单超过17MiB。」，导出与导入都会失败

对每天聊几十条的用户，四千多条半年到一年就能到。这是颗定时炸弹。

改法：17 MiB -> 48 MiB（约 1.2 万条聊天记录），导出与导入两处必须
一起改，否则新导出的包导不回来。

    导出侧 service-DGjhUELY.js @960223  function Ih(e8)
    导入侧 service-DGjhUELY.js @961429  function (读档校验)

两处形状完全一样：
    U(new TextEncoder().encode(e8).length <= 17 * Oh,
      `ARCHIVE_MANIFEST_TOO_LARGE`, `资料清单超过17MiB。`);

为什么不做成不限制：清单是一次 JSON.stringify + TextEncoder 出来的，
48 MiB 已经要吃掉一百多 MB 内存；再往上手机 WebView 有 OOM 风险。
真正要彻底解决得改成分片流式写入，那是重构，不是修 bug。

用法:
    python _patch_phone_archive.py --check
    python _patch_phone_archive.py
    python _patch_phone_archive.py --revert
"""
import argparse
import os
import shutil
import sys

sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
TARGET = os.path.join(HERE, "work", "assets", "public", "assets", "service-DGjhUELY.js")

MARK = "/* ellen-archive-limit */"

# 1) 上限数字（两处）。两处的 encode(...) 参数不同（e8 / Y(e8)），
#    所以锚点只取「比较 + 错误码」这段共同部分。
OLD_LIMIT = "<= 17 * Oh, `ARCHIVE_MANIFEST_TOO_LARGE`"
NEW_LIMIT = "<= 48 * Oh, `ARCHIVE_MANIFEST_TOO_LARGE`"
# 2) 文案里的数字
OLD_TEXT = "\\u8D44\\u6599\\u6E05\\u5355\\u8D85\\u8FC717MiB\\u3002"
NEW_TEXT = "\\u8D44\\u6599\\u6E05\\u5355\\u8D85\\u8FC748MiB\\u3002"

EXPECT_COUNT = 2


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--revert", action="store_true")
    args = ap.parse_args()

    with open(TARGET, encoding="utf-8", newline="") as f:
        text = f.read()

    has = MARK in text
    o_lim = text.count(OLD_LIMIT)
    n_lim = text.count(NEW_LIMIT)
    o_txt = text.count(OLD_TEXT)
    n_txt = text.count(NEW_TEXT)

    def save(new_text):
        shutil.copyfile(TARGET, TARGET + ".bak-archive")
        with open(TARGET, "w", encoding="utf-8", newline="") as f:
            f.write(new_text)

    if args.revert:
        if not has:
            print("[nothing-to-revert] %s" % os.path.basename(TARGET))
            return
        if n_lim != EXPECT_COUNT or n_txt < 1:
            print("[conflict] 补丁态命中 limit=%d text=%d（要求 %d/>=1）" % (n_lim, n_txt, EXPECT_COUNT))
            sys.exit(2)
        new = text.replace(NEW_LIMIT, OLD_LIMIT).replace(NEW_TEXT, OLD_TEXT).replace(MARK + "\n", "", 1)
        save(new)
        print("[reverted] %s" % os.path.basename(TARGET))
        return

    if args.check:
        if has and n_lim == EXPECT_COUNT:
            print("[applied] %s  (48 MiB x2)" % os.path.basename(TARGET))
        elif not has and o_lim == EXPECT_COUNT:
            print("[pending] %s  (仍为 17 MiB x2)" % os.path.basename(TARGET))
        else:
            print("[conflict] 补丁态=%s limit old=%d new=%d（要求 %d）" % (has, o_lim, n_lim, EXPECT_COUNT))
            sys.exit(2)
        return

    if has:
        print("[unchanged] %s" % os.path.basename(TARGET))
        return
    if o_lim != EXPECT_COUNT or o_txt < 1:
        print("[conflict] 原始锚点 limit=%d text=%d（要求 %d/>=1），拒绝改动" % (o_lim, o_txt, EXPECT_COUNT))
        sys.exit(2)

    new = text.replace(OLD_LIMIT, NEW_LIMIT).replace(OLD_TEXT, NEW_TEXT)
    # 在第一处后面插标记，便于 --check 与 --revert 定位
    idx = new.find(NEW_LIMIT)
    new = new[:idx] + MARK + "\n" + new[idx:]
    save(new)
    print("[applied] %s  17MiB -> 48MiB x%d" % (os.path.basename(TARGET), EXPECT_COUNT))


if __name__ == "__main__":
    main()
