"""手机端 ⑤ 会话摘要数据源修正：从窗口 view 换成全量快照 view。

问题：② 摘要 IIFE 读 `y.byId`（je 里 `H(signal,{messageIds,...})` 的召回窗口 view，
实测只有 14 条消息 → `_ol = total-12 = 2`，永远 < 8 → 返回空串，摘要永远不生效。

修法：在 je 里额外 `await H(signal,{complete:true})` 拿全量快照 view（走
`e.readSnapshot()` + `Bl(snapshot,profileId,now)`），摘要优先用它，取不到再退回 `y`。

用法：
    python _patch_phone_memory4.py                 # 打 work 里那份
    python _patch_phone_memory4.py --target <路径>  # 打指定 bundle
    python _patch_phone_memory4.py --check
    python _patch_phone_memory4.py --revert
"""

import argparse
import os
import sys

WORK = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                    "work", "assets", "public", "assets", "service-DGjhUELY.js")

P5_OLD = "p=await H(c,{messageIds:f,conversationId:o,reply:!0}),m=p.view,h=null;"

P5_NEW = ("p=await H(c,{messageIds:f,conversationId:o,reply:!0}),m=p.view;"
          "let _allv=null;"
          "try{const _ap=await H(c,{complete:!0});_allv=_ap?.view??null}catch{};let h=null;")

P6_OLD = "let _vals=y?.byId instanceof Map?[...y.byId.values()]:Object.values(y?.byId??{})"

P6_NEW = ("let _av=_allv??y,"
          "_vals=_av?.byId instanceof Map?[..._av.byId.values()]:Object.values(_av?.byId??{})")

PATCHES = [("P5 全量 view 预取", P5_OLD, P5_NEW),
           ("P6 摘要改用全量", P6_OLD, P6_NEW)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", default=WORK)
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--revert", action="store_true")
    args = ap.parse_args()

    path = args.target
    if not os.path.isfile(path):
        print("找不到 bundle:", path)
        return 2

    s = open(path, encoding="utf-8", errors="ignore").read()
    total = len(s)
    report = []

    for name, old, new in PATCHES:
        has_old = s.count(old)
        has_new = s.count(new)
        if has_old == 1 and has_new == 0:
            report.append((name, "pending", has_old))
        elif has_old == 0 and has_new == 1:
            report.append((name, "applied", has_new))
        else:
            report.append((name, "conflict", (has_old, has_new)))

    if args.check:
        for name, st, cnt in report:
            print(f"{name}: {st} {cnt}")
        return 0 if all(st in ("pending", "applied") for _, st, _ in report) else 1

    if args.revert:
        for name, old, new in PATCHES:
            if s.count(new) == 1 and s.count(old) == 0:
                s = s.replace(new, old)
                print(f"{name}: 已还原")
        open(path, "w", encoding="utf-8", newline="").write(s)
        print("回滚完成，长度", len(s))
        return 0

    changed = 0
    for name, old, new in PATCHES:
        if s.count(new) == 1 and s.count(old) == 0:
            print(f"{name}: 已存在，跳过")
            continue
        if s.count(old) != 1:
            print(f"{name}: 锚点不唯一（命中 {s.count(old)} 次），中止")
            return 1
        s = s.replace(old, new)
        changed += 1
        print(f"{name}: 已打上")

    if changed:
        open(path, "w", encoding="utf-8", newline="").write(s)
        print(f"写回 {path}：{total} → {len(s)} 字符，改动 {changed} 处")
    else:
        print("无需改动")
    return 0


if __name__ == "__main__":
    sys.exit(main())
