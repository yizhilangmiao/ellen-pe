# -*- coding: utf-8 -*-
"""
给 web_out 里每个 JS 文件开头注入 ES5 polyfill。
- 主线程文件和 Worker 文件都会执行到，解决 Worker 拿不到 index.html 内联 polyfill 的问题。
- 幂等：已有 /*ellen-polyfill*/ 标记的跳过。
"""
import io
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web_out")

MARK = "/*ellen-polyfill*/"

POLYFILL = MARK + r"""
(function(){
  var g = (typeof globalThis !== "undefined") ? globalThis
        : (typeof self !== "undefined") ? self
        : (typeof window !== "undefined") ? window : this;
  if (!g || g.__ellen_polyfilled) return;
  g.__ellen_polyfilled = true;

  // ---- structuredClone（Chrome 98）----
  if (typeof g.structuredClone === "undefined") {
    function dc(v, seen) {
      if (v === null || typeof v !== "object") return v;
      if (v instanceof Date) return new Date(v.getTime());
      if (v instanceof RegExp) return new RegExp(v.source, v.flags);
      if (v instanceof ArrayBuffer) return v.slice(0);
      if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView && ArrayBuffer.isView(v)) {
        return new v.constructor(v);
      }
      if (v instanceof Array) {
        var a = new Array(v.length);
        for (var i = 0; i < v.length; i++) a[i] = dc(v[i], seen);
        return a;
      }
      if (typeof Map !== "undefined" && v instanceof Map) {
        var m = new Map();
        v.forEach(function (val, k) { m.set(dc(k, seen), dc(val, seen)); });
        return m;
      }
      if (typeof Set !== "undefined" && v instanceof Set) {
        var st = new Set();
        v.forEach(function (val) { st.add(dc(val, seen)); });
        return st;
      }
      if (typeof Blob !== "undefined" && v instanceof Blob) return v;
      if (typeof URL !== "undefined" && v instanceof URL) return new URL(v.href);
      var o = {};
      for (var k in v) {
        if (Object.prototype.hasOwnProperty.call(v, k)) o[k] = dc(v[k], seen);
      }
      return o;
    }
    g.structuredClone = function (v) { return dc(v); };
  }

  // ---- crypto.randomUUID（Chrome 92）★ 业务层直接断言存在，缺了就抛 CRYPTO_UNAVAILABLE ----
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

  // ---- Object.hasOwn（Chrome 93）----
  if (!Object.hasOwn) {
    Object.hasOwn = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
  }

  // ---- Object.fromEntries（Chrome 73，兜底）----
  if (!Object.fromEntries) {
    Object.fromEntries = function (it) {
      var o = {};
      var arr = Array.from ? Array.from(it) : it;
      for (var i = 0; i < arr.length; i++) o[arr[i][0]] = arr[i][1];
      return o;
    };
  }

  // ---- Array.prototype.at / String.prototype.at（Chrome 92）----
  if (!Array.prototype.at) {
    Array.prototype.at = function (i) {
      i = Math.trunc(i) || 0;
      if (i < 0) i += this.length;
      return this[i];
    };
  }
  if (!String.prototype.at) {
    String.prototype.at = function (i) {
      i = Math.trunc(i) || 0;
      if (i < 0) i += this.length;
      return this[i];
    };
  }

  // ---- String.prototype.replaceAll（Chrome 85）----
  if (!String.prototype.replaceAll) {
    String.prototype.replaceAll = function (p, r) {
      if (p instanceof RegExp) return this.replace(p, r);
      return this.split(String(p)).join(String(r));
    };
  }

  // ---- Array.prototype.flat / flatMap（Chrome 69，兜底）----
  if (!Array.prototype.flat) {
    Array.prototype.flat = function (d) {
      d = d === undefined ? 1 : Math.trunc(d);
      var out = [];
      (function walk(a, dep) {
        for (var i = 0; i < a.length; i++) {
          var x = a[i];
          if (dep > 0 && Array.isArray(x)) walk(x, dep - 1);
          else out.push(x);
        }
      })(this, d);
      return out;
    };
  }
  if (!Array.prototype.flatMap) {
    Array.prototype.flatMap = function (fn, t) {
      return this.map(fn, t).flat(1);
    };
  }

  // ---- Promise.allSettled（Chrome 76）/ Promise.any（Chrome 85）----
  if (typeof Promise !== "undefined") {
    if (!Promise.allSettled) {
      Promise.allSettled = function (it) {
        return Promise.all(Array.from(it).map(function (p) {
          return Promise.resolve(p).then(
            function (v) { return { status: "fulfilled", value: v }; },
            function (e) { return { status: "rejected", reason: e }; }
          );
        }));
      };
    }
    if (!Promise.any) {
      Promise.any = function (it) {
        return new Promise(function (ok, no) {
          var arr = Array.from(it), n = arr.length, errs = new Array(n), left = n;
          if (!n) { no(new Error("All promises were rejected")); return; }
          arr.forEach(function (p, i) {
            Promise.resolve(p).then(ok, function (e) {
              errs[i] = e;
              if (--left === 0) {
                var r = new Error("All promises were rejected");
                r.name = "AggregateError";
                r.errors = errs;
                no(r);
              }
            });
          });
        });
      };
    }
  }

  // ---- WeakRef（Chrome 84）----
  if (typeof WeakRef === "undefined") {
    g.WeakRef = function (t) { this._t = t; };
    g.WeakRef.prototype.deref = function () { return this._t; };
  }
  if (typeof FinalizationRegistry === "undefined") {
    g.FinalizationRegistry = function () {};
    g.FinalizationRegistry.prototype.register = function () {};
    g.FinalizationRegistry.prototype.unregister = function () {};
  }

  // ---- queueMicrotask（Chrome 71，兜底）----
  if (typeof g.queueMicrotask === "undefined") {
    g.queueMicrotask = function (fn) {
      Promise.resolve().then(fn);
    };
  }

  // ---- ParentNode.replaceChildren（Chrome 86）★ 主 JS 用了 129 次 ----
  function myReplaceChildren() {
    while (this.firstChild) this.removeChild(this.firstChild);
    for (var i = 0; i < arguments.length; i++) {
      var n = arguments[i];
      this.appendChild(typeof n === "string" ? this.ownerDocument.createTextNode(n) : n);
    }
  }
  if (typeof Element !== "undefined" && !Element.prototype.replaceChildren) {
    Element.prototype.replaceChildren = myReplaceChildren;
  }
  if (typeof Document !== "undefined" && Document.prototype && !Document.prototype.replaceChildren) {
    Document.prototype.replaceChildren = myReplaceChildren;
  }
  if (typeof DocumentFragment !== "undefined" && !DocumentFragment.prototype.replaceChildren) {
    DocumentFragment.prototype.replaceChildren = myReplaceChildren;
  }
  if (typeof ShadowRoot !== "undefined" && !ShadowRoot.prototype.replaceChildren) {
    ShadowRoot.prototype.replaceChildren = myReplaceChildren;
  }

  // ---- ::has 兼容标记（Chrome 105 才有，仅记录，不改布局）----
  if (typeof CSS !== "undefined" && CSS.supports && !CSS.supports("selector(:has(*))")) {
    g.__ellen_no_css_has = true;
  }
})();
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

    changed, skipped, total = 0, 0, 0
    for path in sorted(targets):
        with io.open(path, "r", encoding="utf-8", newline="") as f:
            s = f.read()
        total += 1
        if MARK in s[:4000]:
            skipped += 1
            continue
        with io.open(path, "w", encoding="utf-8", newline="") as f:
            f.write(POLYFILL + s)
        changed += 1
        rel = os.path.relpath(path, ROOT)
        print(f"  [OK] {rel:48} {len(s):>9} -> {len(s) + len(POLYFILL):>9}")

    print()
    print(f"total={total} changed={changed} skipped={skipped}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
