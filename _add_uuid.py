# -*- coding: utf-8 -*-
"""
给 web_out 里已注入过 /*ellen-polyfill*/ 的每个 JS 文件补一段 crypto.randomUUID。

背景：0.1.8 / 0.1.20 的业务层有硬断言
    H(typeof globalThis.crypto?.randomUUID == `function`, `CRYPTO_UNAVAILABLE`, `平台尚未提供安全标识生成器。`)
crypto.randomUUID 需要 Chrome 92，而 vivo Y76s 的 Android System WebView 是 Chrome 83，
于是启动到 storage 阶段就抛 DataError(CRYPTO_UNAVAILABLE)，整个启动失败。

幂等：已含 __ellen_uuid_patched 标记的跳过。
不重建整条链，只在现有 polyfill IIFE 里插一段，改动面最小。
"""
import io
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web_out")

ANCHOR = "g.__ellen_polyfilled = true;"
MARK = "__ellen_uuid_patched"

SNIPPET = r"""
  g.__ellen_uuid_patched = true;
  // ---- crypto.randomUUID（Chrome 92）★ 业务层 H() 硬断言，缺了抛 CRYPTO_UNAVAILABLE ----
  try {
    var _c = (typeof g.crypto !== "undefined" && g.crypto) ? g.crypto : null;
    if (_c && typeof _c.randomUUID !== "function") {
      var _rnd = function (n) {
        var b = new Uint8Array(n);
        if (typeof _c.getRandomValues === "function") { _c.getRandomValues(b); }
        else { for (var i = 0; i < n; i++) b[i] = (Math.random() * 256) | 0; }
        return b;
      };
      var _hex = function (b, s, e) {
        var out = "";
        for (var i = s; i < e; i++) out += (b[i] + 0x100).toString(16).slice(1);
        return out;
      };
      var _uuid = function () {
        var b = _rnd(16);
        b[6] = (b[6] & 0x0f) | 0x40;
        b[8] = (b[8] & 0x3f) | 0x80;
        return _hex(b, 0, 4) + "-" + _hex(b, 4, 6) + "-" + _hex(b, 6, 8) + "-" + _hex(b, 8, 10) + "-" + _hex(b, 10, 16);
      };
      try {
        Object.defineProperty(_c, "randomUUID", { value: _uuid, writable: true, configurable: true, enumerable: false });
      } catch (_e1) {
        try { _c.randomUUID = _uuid; } catch (_e3) {}
      }
    }
  } catch (_e2) {}
"""


def main():
    if not os.path.isdir(ROOT):
        print(f"[ERR] 找不到 {ROOT}")
        return 1

    targets = []
    for dirpath, _dirnames, filenames in os.walk(ROOT):
        for fn in filenames:
            if fn.lower().endswith((".js", ".mjs")):
                targets.append(os.path.join(dirpath, fn))

    changed = skipped = nosrc = total = 0
    for path in sorted(targets):
        with io.open(path, "r", encoding="utf-8", newline="") as f:
            s = f.read()
        total += 1
        rel = os.path.relpath(path, ROOT)

        if MARK in s:
            skipped += 1
            print(f"  [SKIP] {rel}")
            continue
        if ANCHOR not in s:
            nosrc += 1
            print(f"  [NOSRC] {rel}  (没有 polyfill 锚点)")
            continue

        s2 = s.replace(ANCHOR, ANCHOR + SNIPPET, 1)
        with io.open(path, "w", encoding="utf-8", newline="") as f:
            f.write(s2)
        changed += 1
        print(f"  [OK] {rel:46} {len(s):>9} -> {len(s2):>9}")

    print()
    print(f"total={total} changed={changed} skipped={skipped} nosrc={nosrc}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
