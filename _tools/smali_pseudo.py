"""smali 伪代码压缩器 —— 把 .method 体压成 20 行以内可读骨架。

原 smali 一行一条指令、还有 .line/.registers/.locals 等噪声，一个 60 行的 Kotlin 方法能膨胀成 400 行 smali。
这里只保留有语义的指令，并把 `invoke-virtual {p1}, Lcom/getcapacitor/PluginCall;->getString(...)`
压成 `PluginCall.getString`，够写 Kotlin 用。

用法：
    python _tools/smali_pseudo.py <file.smali> [方法名过滤...]

不给方法名 = 打印全部方法（含 @PluginMethod 标记）。
"""

import re
import sys
from pathlib import Path

SKIP_PREFIX = (".line", ".registers", ".locals", ".param", ".prologue", ".end param",
               ".annotation", ".end annotation", ".source", ".restart local", ".local ",
               "nop", ".catch", ".catchall", ".end local", ".array-data", ".packed-switch",
               ".sparse-switch", ".end array-data", ".end packed-switch", ".end sparse-switch")

KEEP = ("const", "invoke", "iget", "iput", "sget", "sput", "new-instance", "new-array",
        "move-result", "return", "if-", "goto", "throw", "check-cast", "filled-new-array",
        "instance-of", "aput", "aget", "add-int", "sub-int", "and-int", "or-int",
        "div-int", "rem-int", "mul-int", "neg-int", "int-to-long", "long-to-int",
        "cmp", "xor-int", "shl-int", "shr-int", "rsub-int", "array-length")


def short_class(desc):
    return desc.strip("L;").split("/")[-1].replace("$", ".")


def compress(line):
    s = line.strip()
    if not s or s.startswith("#"):
        return None
    if s.startswith(SKIP_PREFIX):
        return None
    if s.startswith(".method") or s.startswith(".end method"):
        return s
    if not s.startswith(KEEP) and not s.startswith(":"):
        return None
    m = re.search(r",\s*(L[\w/$]+;|[A-Za-z][\w/$]*)->([\w$<>]+)\(", s)
    if m:
        cls, meth = short_class(m.group(1)), m.group(2)
        args = ""
        am = re.search(r"\((.*?)\)", s)
        if am:
            args = am.group(1)
        args = ", ".join(short_class(a) if a.startswith("L") else a for a in re.findall(r"L[\w/$]+;|\[?[ZBSCIJFD]", args))
        argstr = f"({args})"
        if s.startswith("invoke"):
            return f"  {cls}.{meth}{argstr}"
        return f"  {s.split()[0]} → {cls}.{meth}"
    cm = re.search(r'const-string(?:/jumbo)?\s+\S+,\s*"(.*)"$', s)
    if cm:
        return f'  "{cm.group(1)}"'
    cm2 = re.search(r"const(?:/4|/16|/high16)?\s+(\S+),\s*(-?0x[0-9a-fA-F]+|-?\d+)", s)
    if cm2:
        return f"  {cm2.group(1)} = {cm2.group(2)}"
    fm = re.search(r"(iget|iput|sget|sput)\S*\s+\S+,\s*\S*,\s*(L[\w/$]+;)->(\w+):(\S+)", s)
    if fm:
        return f"  {fm.group(1)} {short_class(fm.group(2))}.{fm.group(3)}"
    nm = re.search(r"new-instance\s+\S+,\s*(L[\w/$]+;)", s)
    if nm:
        return f"  new {short_class(nm.group(1))}"
    if s.startswith("return"):
        return "  " + s
    if s.startswith("if-") or s.startswith("goto"):
        return "  " + s.split()[0].upper() + " " + s.split()[-1]
    return "  " + re.sub(r"\s+", " ", s)


def main():
    path = Path(sys.argv[1])
    wanted = sys.argv[2:]
    text = path.read_text(encoding="utf-8", errors="replace")
    out, cur, anno = [], None, False
    print(f"===== {path.name} =====")
    lines = text.splitlines()
    for line in lines:
        s = line.strip()
        if s.startswith(".method"):
            cur = s.replace(".method ", "")
            anno = False
            continue
        if s.startswith(".end method"):
            if cur and (not wanted or any(w in cur for w in wanted)):
                print(f"\n--- {cur} ---")
                for c in out:
                    print(c)
            cur, out, anno = None, [], False
            continue
        if cur is None:
            continue
        if "Lcom/getcapacitor/PluginMethod;" in s:
            anno = True
            continue
        c = compress(line)
        if c:
            if c.startswith(".method"):
                continue
            out.append(c)
    if cur and (not wanted or any(w in cur for w in wanted)):
        print(f"\n--- {cur} ---")
        for c in out:
            print(c)


if __name__ == "__main__":
    main()
