# -*- coding: utf-8 -*-
"""手机版修：动作描述开起来后，语音偶尔把「（动作）」也念出来。

根因（persona-CBp1pExX.js 的 spoken/x=forSegment）：
    function i2(e3) { let n3 = r2(e3); return n3 ? t2(n3) : e3?.text || ``; }
r2 = forSegment，要求 `display(sceneParts) === text` 严格相等；一旦模型给的
sceneParts 跟 text 差一个空格/标点，或者这条消息压根没有 sceneParts（老消息、
模型没按协议输出），r2 返回 null，朗读就直接吃整条 text —— 而入库的 text 是
display 拼出来的，动作段本来就带着 `（…）`，于是被 TTS 念出来。

修法：朗读文本统一过一遍「剥括号动作」再送合成，剥完没实词才退回原文
（避免掉进 tr() 的 INVALID_SPEECH_TEXT，让用户看到"这条台词暂时无法合成"）。
只动朗读取值，不动 r2 与渲染路径（display / paint / visibleSegments 照旧）。

用法:
    python _patch_phone_readaloud.py --check     # 只报告，不写盘
    python _patch_phone_readaloud.py             # 打补丁
    python _patch_phone_readaloud.py --revert    # 撤回
"""
import argparse
import os
import shutil
import sys

sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
TARGET = os.path.join(HERE, "work", "assets", "public", "assets", "persona-CBp1pExX.js")

MARK = "/* ellen-readaloud-strip */"

OLD = """  function i2(e3) {
    let n3 = r2(e3);
    return n3 ? t2(n3) : (e3 == null ? void 0 : e3.text) || ``;
  }"""

NEW = """  function i2(e3) {
    """ + MARK + """
    let n3 = r2(e3), o3 = n3 ? t2(n3) : (e3 == null ? void 0 : e3.text) || ``;
    if (typeof o3 != `string` || !o3) return o3 || ``;
    let s3 = o3.replace(/[\\uFF08(][^\\uFF08()\\uFF09\\r\\n]{1,60}[\\uFF09)]/gu, ``).replace(/[\\u3010\\[][^\\u3010\\u3011\\[\\]\\r\\n]{1,60}[\\u3011\\]]/gu, ``).replace(/\\*[^*\\r\\n]{1,60}\\*/gu, ``);
    return /[\\p{L}\\p{N}]/u.test(s3) ? s3.replace(/[ \\t]{2,}/gu, ` `).trim() : o3;
  }"""


def load():
    if not os.path.isfile(TARGET):
        sys.exit("缺目标文件: " + TARGET + "（先跑 _dev_extract.py）")
    with open(TARGET, encoding="utf-8", newline="") as f:
        return f.read()


def save(text):
    bak = TARGET + ".bak-readaloud"
    shutil.copyfile(TARGET, bak)
    with open(TARGET, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    return bak


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--revert", action="store_true")
    args = ap.parse_args()

    text = load()
    has = MARK in text
    old_n = text.count(OLD)
    new_n = text.count(NEW)
    state, note = "", ""

    if args.revert:
        if not has:
            state, note = "nothing-to-revert", ""
        elif new_n != 1:
            state, note = "conflict", "已打补丁的段落命中 %d 次（要求 1 次）" % new_n
        else:
            save(text.replace(NEW, OLD, 1))
            state = "reverted"
    elif args.check:
        state = "applied" if has else ("pending" if old_n == 1 else "conflict")
        if not has and old_n != 1:
            note = "原始锚点命中 %d 次（要求 1 次）" % old_n
    else:
        if has:
            state = "unchanged"
        elif old_n != 1:
            state, note = "conflict", "原始锚点命中 %d 次（要求 1 次），拒绝改动" % old_n
        else:
            bak = save(text.replace(OLD, NEW, 1))
            state, note = "applied", "备份 " + os.path.basename(bak)

    print("[%s] %s" % (state, os.path.relpath(TARGET, HERE)))
    if note:
        print("  " + note)
    if state == "conflict":
        sys.exit(2)


if __name__ == "__main__":
    main()
