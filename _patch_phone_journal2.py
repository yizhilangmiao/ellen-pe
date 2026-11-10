# -*- coding: utf-8 -*-
"""手机版修：「更新手记」被「模型作品引用了未提供的用户原话，未保存。」拦下。

现象（真机 2026-11-01，对 10-31 已写好的手记点「更新手记」）：
    红字：模型作品引用了未提供的用户原话，未保存。
    旧手记保留不变（这是好事，没有被脏数据覆盖）。

定性（service-DGjhUELY.js @707082 / storage-worker-C5hDp6Bk.js @1462277）：
    提交手记时的校验是

        let v3 = new Set([...batch, ...evidence]
                          .filter(m => m.role === 'user').map(m => m.id));
        U([...sourceIds, ...understanding.sourceIds].every(id => v3.has(id)),
          'INVALID_JOURNAL_EVIDENCE',
          '模型作品引用了未提供的用户原话，未保存。');

    也就是：模型写出来的 sourceIds 必须**全部落在本轮 batch/evidence 里的
    用户消息 id** 之内。

    问题在「手记是累积的」——

        let S3 = Df([...(旧 sourceIds ∩ 当天可见), ...新 sourceIds])

    旧记录的 sourceIds 是会保留并累积的，而模型看到的是当天全部原话，
    它引用「当天有、但本轮没再喂一遍」的旧原话完全合理，却会被判成
    INVALID_JOURNAL_EVIDENCE。于是同一天第二次整理、或者当天消息多到要
    分批送模型时，更新就随机失败。

    注意：紧挨着上面的 sourceProof CAS 已经保证了「本轮实际使用的原话没变」，

        U(h3.every(m => m3.has(m.id)) && P2(...) === n3.sourceProof,
          'STALE_JOURNAL_SOURCES', ...);

    所以真正的防伪锚点是 sourceProof，不是这个 id 子集校验。

修法：把合法集合从「本轮 batch+evidence 的 user 消息」放宽到
      「当天全部可见 user 消息」——
        service:         f3  （= N2(s3, n3.day, l3, c3)）
        storage-worker:  m3  （= I2(c3, r2.day, d3, l3)）
      这两个都是「这一天、当前时区、可见的原话」，模型仍然不能凭空编 id
      （编的 id 不在这天里，照样被拒），安全底线不动。

      改动是把 `[...X.batch, ...X.evidence]` 换成当天集合，两处各一次。

用法:
    python _patch_phone_journal2.py --check
    python _patch_phone_journal2.py
    python _patch_phone_journal2.py --revert
"""
import argparse
import os
import shutil
import sys

sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
ADIR = os.path.join(HERE, "work", "assets", "public", "assets")

MARK = "/* ellen-journal-evidence-scope */"

# (文件, 旧串, 新串)
CASES = [
    (
        os.path.join(ADIR, "service-DGjhUELY.js"),
        "let v3 = new Set([...n3.batch, ...n3.evidence].filter((e10) => e10.role === `user`).map((e10) => e10.id))",
        "let v3 = new Set(f3.filter((e10) => e10.role === `user`).map((e10) => e10.id)) " + MARK,
    ),
    (
        os.path.join(ADIR, "storage-worker-C5hDp6Bk.js"),
        "let v3 = new Set([...r2.batch, ...r2.evidence].filter((e4) => e4.role === `user`).map((e4) => e4.id))",
        "let v3 = new Set(m3.filter((e4) => e4.role === `user`).map((e4) => e4.id)) " + MARK,
    ),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--revert", action="store_true")
    args = ap.parse_args()

    bad = 0
    for path, old, new in CASES:
        name = os.path.basename(path)
        if not os.path.isfile(path):
            print("[missing] " + name)
            bad += 1
            continue
        with open(path, encoding="utf-8", newline="") as f:
            text = f.read()

        has = MARK in text
        old_n = text.count(old)
        new_n = text.count(new)
        state, note = "", ""

        if args.revert:
            if not has:
                state = "nothing-to-revert"
            elif new_n != 1:
                state, note = "conflict", "补丁段命中 %d 次（要求 1 次）" % new_n
            else:
                shutil.copyfile(path, path + ".bak-journal2")
                with open(path, "w", encoding="utf-8", newline="") as f:
                    f.write(text.replace(new, old, 1))
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
                shutil.copyfile(path, path + ".bak-journal2")
                with open(path, "w", encoding="utf-8", newline="") as f:
                    f.write(text.replace(old, new, 1))
                state = "applied"

        if state == "conflict":
            bad += 1
        print("[%s] %s%s" % (state, name, ("  " + note) if note else ""))

    if bad:
        sys.exit(2)


if __name__ == "__main__":
    main()
