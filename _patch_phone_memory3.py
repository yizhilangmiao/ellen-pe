#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""手机端记忆第 5 项补丁：让「共同经历」显示 kind=user_fact（关于你）的记忆。

背景：分组模式下列表只取 kind=shared_event，而 0.1.20 里用户说的
「我养了猫 / 我的生日 / 我爱好」全部被整理成 kind=user_fact，
于是「回忆 → 记忆 → 共同经历」永远 0 条，用户以为没有记忆。
卡片本身已按 pu[kind] 打印「关于你 / 共同经历」，混排不会混淆。

幂等：按 新文本是否已存在 判 applied；冲突（锚点数量 != 1）直接退出。
用法：
    python _patch_phone_memory3.py --check
    python _patch_phone_memory3.py
    python _patch_phone_memory3.py --target <bundle> 
    python _patch_phone_memory3.py --revert
"""
import argparse
import sys

DEFAULT = r"work\assets\public\assets\main-CFFhpb4h.js"

# (说明, 原文, 替换)
PATCHES = [
    (
        "列表过滤：shared_event | user_fact",
        "O=k.filter(e=>!f||e.kind===`shared_event`)",
        "O=k.filter(e=>!f||e.kind===`shared_event`||e.kind===`user_fact`)",
    ),
    (
        "点开卡片的默认列表同样放行 user_fact",
        "function Ce(e,t=k.filter(e=>!f||e.kind===`shared_event`)){",
        "function Ce(e,t=k.filter(e=>!f||e.kind===`shared_event`||e.kind===`user_fact`)){",
    ),
    (
        "空态文案不再写死「共同经历」",
        "f?`这里还没有留下你们的共同经历。`:`这里还没有留下记忆。`",
        "`这里还没有留下记忆。`",
    ),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", default=DEFAULT)
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--revert", action="store_true")
    a = ap.parse_args()

    s = open(a.target, encoding="utf-8", errors="ignore").read()
    orig = len(s)

    pending, applied, conflict = [], [], []
    for name, old, new in PATCHES:
        n_old, n_new = s.count(old), s.count(new)
        if a.revert:
            if n_new >= 1 and n_old == 0:
                pending.append((name, new, old))
            elif n_old == 1:
                applied.append(name)
            else:
                conflict.append((name, f"old={n_old} new={n_new}"))
            continue
        if n_new >= 1 and n_old == 0:
            applied.append(name)
        elif n_old == 1:
            pending.append((name, old, new))
        else:
            conflict.append((name, f"old={n_old} new={n_new}"))

    print(f"目标: {a.target}")
    print(f"长度: {orig}")
    print(f"已应用: {applied or '无'}")
    print(f"待处理: {[p[0] for p in pending] or '无'}")
    if conflict:
        print(f"冲突: {conflict}")
        sys.exit(2)

    if a.check:
        return
    if not pending:
        print("无需改动。")
        return

    for _, old, new in pending:
        s = s.replace(old, new, 1)
    open(a.target, "w", encoding="utf-8", newline="").write(s)
    print(f"已写入，新长度: {len(s)}")


if __name__ == "__main__":
    main()
