# -*- coding: utf-8 -*-
"""手机版修：「整理这天的 手记」撞输出额度上限（finish_reason=length）。

现象（老大真机截图，2026-10-31 晚）：
    DeepSeek 聊天服务：本次思考或回复达到输出额度上限。可降低思考强度或
    减少回复内容后重试。 未自动重试。
    卡片：「这天的手记 / 还没有记录。」

定性（service-DGjhUELY.js 取证，不是猜）：
    1) 不是余额不足。余额不足走 balance 类，文案是「账户余额不足，请到
       DeepSeek 开放平台检查余额并充值后再发送。」（HTTP 402）。
    2) 不是上下文超限。那是 context 类「这次对话内容超过模型长度限制，
       请缩短消息、减少附件或新建对话后重试。」
    3) 是输出 token 用尽。@63277 的 finishReason 映射表里
       `length: 输出额度用尽`，而 @1158706 的判错分支是
           s2 === `journal` && d3 === `length` ? `JOURNAL_OUTPUT_LIMIT` : void 0
       即手记任务撞 length 时错误码是 JOURNAL_OUTPUT_LIMIT。
    4) 「未自动重试」只是文案尾巴，不是状态。ChatServiceError 的
       super() 固定拼 `${s2[r2]} 未自动重试。`；真实重试在自动任务系统里，
       Zr() 白名单**包含** JOURNAL_OUTPUT_LIMIT，退避表 qr = [60s, 300s, 1800s]，
       最多 3 次。10-31 那天的手记最后确实写出来了（「雨夜里的碎碎念」）。

根因：手记这次模型调用的输出预算是 maxTokens = 4000（@1317574），
      而带 reasoning 的模型把思考 token 也算进这个预算 —— 聊天页顶部
      「思考 · 默认」没关，思考多写几句，正文就没额度了，直接 length。

修法：把 journal 这一处的 maxTokens 从 4e3 提到 8e3。
      4e3 → 8e3 是单字符改动（4→8），不改变语法结构；8e3 仍在
      DeepSeek 侧 max_tokens 上限（8192）之内，也远低于本包
      Nt() 校验的 1e6 上限。其它 purpose（memory/translation/emotion）
      的输出预算一律不动。

用法:
    python _patch_phone_journal.py --check     # 只报告，不写盘
    python _patch_phone_journal.py             # 打补丁
    python _patch_phone_journal.py --revert    # 撤回
"""
import argparse
import os
import shutil
import sys

sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
TARGET = os.path.join(HERE, "work", "assets", "public", "assets", "service-DGjhUELY.js")

MARK = "/* ellen-journal-budget */"

OLD = "signal: n2, maxTokens: 4e3, purpose: `journal`"
NEW = "signal: n2, maxTokens: 8e3 " + MARK + ", purpose: `journal`"


def load():
    if not os.path.isfile(TARGET):
        sys.exit("缺目标文件: " + TARGET + "（先跑 _dev_extract.py）")
    with open(TARGET, encoding="utf-8", newline="") as f:
        return f.read()


def save(text):
    bak = TARGET + ".bak-journal"
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
            state = "nothing-to-revert"
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
