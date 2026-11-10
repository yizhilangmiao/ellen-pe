# -*- coding: utf-8 -*-
"""手机版修：「手记／记忆整理」撞输出额度上限（finish_reason=length）。

现象（真机 2026-11-01）：
    DeepSeek 聊天服务：本次思考或回复达到输出额度上限。可降低思考强度或
    减少回复内容后重试。 未自动重试。

上一版（_patch_phone_journal.py）只把 journal 的 maxTokens 从 4000 抬到
8000，仍然撞。说明瓶颈不在「名义预算」，而在**思考 token 和正文抢同一个
输出预算**——带 reasoning 的模型先把 4000/8000 花在思考上，正文就没额度了。

定性（service-DGjhUELY.js）：

    function b2(e9, t3, { purpose: n3 } = {}) {        // 实际是 zv()
      let i3 = g2(e9.endpoint, e9.model, e9.thinking),   // ← 思考档位
          a3 = n3 === `connection-test` && [...].includes(r3.kind);
      a3 && (i3 = g2(..., `off`));
      ...
      if (i3 === `off`) return { fields: ... { thinking: { type: `disabled` } },
                                 maxTokens: t3 };       // ← 关掉后就用我们给的预算
      let s3 = { off: [0, 9e4], low: [8192, 12e4], medium: [16384, 15e4], ... }[...];
      return { ..., maxTokens: r3.separateBudget ? t3 : Math.max(t3, s3[0]), ... };
    }

    `t2 = new Set(['deepseek-flash','deepseek-v4-pro','deepseek-v4-flash',...])`
    说明 deepseek-flash 是**支持 `off`（关闭思考）**的档位模型，
    而聊天页顶部 chip 现在是「◇ 思考 · 默认」，即跟随模型默认，
    默认档位给 deepseek-flash 的预算（medium 16384）也会被整段思考吃掉。

修法：让「不用动脑子的后台任务」显式关闭思考 ——
      `journal`（手记）和 `memory`（记忆整理）都是**把已有原话整理成文字**，
      不需要推理链。关掉后：
        · fields 变成 { thinking: { type: 'disabled' } }
        · maxTokens 直接用调用方给的预算（journal 8000 / memory 3000·批）
      聊天、情绪、翻译这些**不动**，仍然跟随用户的思考档位设置。

      connection-test 早就是这么干的（a3 那条），这里只是把同类原则
      用到两个后台整理任务上。

用法:
    python _patch_phone_journal3.py --check
    python _patch_phone_journal3.py
    python _patch_phone_journal3.py --revert
"""
import argparse
import os
import shutil
import sys

sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
TARGET = os.path.join(HERE, "work", "assets", "public", "assets", "service-DGjhUELY.js")

MARK = "/* ellen-journal-nothink */"

OLD = "let i3 = g2(e9.endpoint, e9.model, e9.thinking), a3 = n3 === `connection-test`"
NEW = (
    "let i3 = g2(e9.endpoint, e9.model, "
    "n3 === `journal` || n3 === `memory` ? `off` : e9.thinking)"
    " " + MARK + ", a3 = n3 === `connection-test`"
)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--revert", action="store_true")
    args = ap.parse_args()

    if not os.path.isfile(TARGET):
        sys.exit("缺目标文件: " + TARGET)
    with open(TARGET, encoding="utf-8", newline="") as f:
        text = f.read()

    has = MARK in text
    old_n = text.count(OLD)
    new_n = text.count(NEW)
    state, note = "", ""

    if args.revert:
        if not has:
            state = "nothing-to-revert"
        elif new_n != 1:
            state, note = "conflict", "补丁段命中 %d 次（要求 1 次）" % new_n
        else:
            shutil.copyfile(TARGET, TARGET + ".bak-journal3")
            with open(TARGET, "w", encoding="utf-8", newline="") as f:
                f.write(text.replace(NEW, OLD, 1))
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
            shutil.copyfile(TARGET, TARGET + ".bak-journal3")
            with open(TARGET, "w", encoding="utf-8", newline="") as f:
                f.write(text.replace(OLD, NEW, 1))
            state = "applied"

    print("[%s] %s%s" % (state, os.path.basename(TARGET), ("  " + note) if note else ""))
    if state == "conflict":
        sys.exit(2)


if __name__ == "__main__":
    main()
