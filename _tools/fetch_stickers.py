# -*- coding: utf-8 -*-
"""绝区零官方表情包取材脚本（米游社表情集 -> 320×320 WebP + stickers.js）

用法：
  python _tools/fetch_stickers.py            # 全流程（下载/去重/归一化/生成清单）
  python _tools/fetch_stickers.py --check    # 只统计，不改文件

取材源：https://bbs-api.miyoushe.com/misc/api/emoticon_set?gids=8
  只用三套：id=13 绝区零官方 / id=14 米仔 / id=16 绝区零「丽都漫步」系列
产物：
  app/web/src/app/assets/stickers/sXXX.webp   （320×320 透明画布，等比放入，WebP q88）
  app/web/src/app/assets/stickers.js          （STICKERS / STICKER_SETS / STICKER_FAVORITES）

注意：
  - 米游社原表里有同图重复挂载（实测 s077=s080、s078=s079、s143=s193），按内容 sha256 去重。
  - stickers.js 里 stickerUrl() 用 import.meta.glob，裸 node 跑不了，只能在 vite 里用。
  - 素材版权归米哈游，个人非商业使用。
  - ⚠ 重跑会按当前顺序重新编号（s001…），已有消息/数据里引用的 sticker id 会错位；
    新增表情时应改脚本做「增量追加」而不是整体重编。
"""
import io
import json
import os
import subprocess
import sys
import hashlib
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "app", "web", "src", "app", "assets", "stickers")
JS_PATH = os.path.join(ROOT, "app", "web", "src", "app", "assets", "stickers.js")
WORK = os.path.join(os.environ.get("TEMP", "."), "ellen-stickers")
SETS = {"13": ("绝区零官方", "official", "character"),
        "14": ("米仔", "bangboo", "bangboo"),
        "16": ("丽都漫步", "lido", "character")}
API = "https://bbs-api.miyoushe.com/misc/api/emoticon_set?gids=8"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36"
SIZE = 320
CHECK = "--check" in sys.argv


def sh(args):
    return subprocess.run(args, capture_output=True).stdout


def fetch_json(url, ref):
    raw = sh(["curl", "-sL", "--max-time", "40", "-H", "User-Agent: " + UA, "-H", "Referer: " + ref, url])
    return json.loads(raw.decode("utf-8", "replace"))


def main():
    os.makedirs(WORK, exist_ok=True)
    js = fetch_json(API, "https://www.miyoushe.com/")
    items = []
    for s in js["data"]["list"]:
        key = str(s.get("id"))
        if key not in SETS:
            continue
        label, group, kind = SETS[key]
        for it in s.get("list") or []:
            items.append({"set": label, "group": group, "kind": kind,
                          "name": it["name"], "url": it["icon"]})
    print("remote items:", len(items))
    if CHECK:
        print("out dir files:", len([f for f in os.listdir(OUT_DIR) if f.endswith('.webp')]) if os.path.isdir(OUT_DIR) else 0)
        return

    os.makedirs(OUT_DIR, exist_ok=True)
    raw_dir = os.path.join(WORK, "raw")
    os.makedirs(raw_dir, exist_ok=True)

    def dl(t):
        i, it = t
        p = os.path.join(raw_dir, "r%03d.png" % i)
        if not (os.path.exists(p) and os.path.getsize(p) > 1000):
            subprocess.run(["curl", "-sL", "--max-time", "40", "-H", "Referer: https://www.miyoushe.com/",
                            "-o", p, it["url"]])
        return p

    with ThreadPoolExecutor(12) as ex:
        paths = list(ex.map(dl, enumerate(items)))
    print("downloaded:", sum(1 for p in paths if os.path.exists(p)))

    from PIL import Image
    seen, kept = {}, []
    for i, (it, p) in enumerate(zip(items, paths)):
        h = hashlib.sha256(io.open(p, "rb").read()).hexdigest()
        if h in seen:
            print("  dup skipped: %s == %s" % (it["name"], seen[h]))
            continue
        seen[h] = it["name"]
        sid = "s%03d" % (len(kept) + 1)
        im = Image.open(p).convert("RGBA")
        w, hh = im.size
        if max(w, hh) > SIZE:
            k = SIZE / max(w, hh)
            im = im.resize((max(1, int(w * k)), max(1, int(hh * k))), Image.LANCZOS)
        canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
        canvas.paste(im, ((SIZE - im.size[0]) // 2, (SIZE - im.size[1]) // 2), im)
        canvas.save(os.path.join(OUT_DIR, sid + ".webp"), "WEBP", quality=88, method=6)
        kept.append(dict(it, id=sid, file=sid + ".webp"))
    print("kept:", len(kept))

    counts = {}
    for k in kept:
        counts[k["set"]] = counts.get(k["set"], 0) + 1
    head = [
        "// 绝区零官方表情包（米游社社区表情，共 %d 张）" % len(kept),
        "// 来源：米游社表情集 API  emoticon_set?gids=8",
        "//   id=13 绝区零官方 / id=14 米仔 / id=16 绝区零「丽都漫步」系列",
        "// 处理：等比缩到长边 ≤%d，居中贴 %d×%d 透明画布，WebP q88；由 _tools/fetch_stickers.py 生成" % (SIZE, SIZE, SIZE),
        "// 素材版权归米哈游所有，仅作个人非商业使用",
        "export const STICKER_SETS = [",
    ]
    for group in ("lido", "official", "bangboo"):
        label = [v[0] for v in SETS.values() if v[1] == group][0]
        head.append('  { key: "%s", label: "%s", count: %d },' % (group, label, counts.get(label, 0)))
    head.append("];")
    head.append("")
    head.append("export const STICKERS = [")
    for k in kept:
        head.append('  { id: %s, file: %s, label: %s, set: %s, kind: %s },'
                    % (json.dumps(k["id"]), json.dumps(k["file"]), json.dumps(k["name"], ensure_ascii=False),
                       json.dumps(k["set"], ensure_ascii=False), json.dumps(k["kind"])))
    head.append("];")
    head.append("")
    head.append("export function stickerById(id) { return STICKERS.find((s) => s.id === id) || null; }")
    head.append("const STICKER_FILES = import.meta.glob(\"./stickers/*.webp\", { eager: true, import: \"default\" });")
    head.append("export function stickerUrl(sticker) { return STICKER_FILES[`./stickers/${sticker.file}`] || \"\"; }")
    # 首屏常用：重跑时保留原 FAVORITES 段
    fav = ""
    if os.path.exists(JS_PATH):
        old = io.open(JS_PATH, encoding="utf-8").read()
        i = old.find("export const STICKER_FAVORITES")
        if i > 0:
            fav = "\n\n" + old[i:].rstrip() + "\n"
    io.open(JS_PATH, "w", encoding="utf-8", newline="\n").write("\n".join(head) + "\n" + fav)
    print("wrote", JS_PATH)


if __name__ == "__main__":
    main()
