# -*- coding: utf-8 -*-
"""把 web/ 下的非 JS 资源复制到 web_out/，并给 index.html 与 autonomy.html 注入 ES5 polyfill。"""
import os, shutil, sys

sys.stdout.reconfigure(encoding='utf-8')

WEB = r'E:\ailian\_临时\legacy\web'
OUT = r'E:\ailian\_临时\legacy\web_out'
JS_EXT = ('.js', '.mjs')

POLYFILL = r'''<script>
/*ellen-webview-polyfill - ES5 only, must run before any module script*/
(function () {
  "use strict";
  var w = typeof globalThis !== "undefined" ? globalThis : window;

  if (typeof w.structuredClone !== "function") {
    w.structuredClone = function (v) {
      if (v === null || typeof v !== "object") return v;
      if (typeof v === "function") return v;
      try { return JSON.parse(JSON.stringify(v)); } catch (e) { return v; }
    };
  }
  if (!Object.hasOwn) {
    Object.hasOwn = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
  }
  if (!Object.fromEntries) {
    Object.fromEntries = function (it) {
      var r = {};
      if (!it) return r;
      var arr = (typeof it[Symbol.iterator] === "function") ? Array.from(it) : it;
      for (var i = 0; i < arr.length; i++) r[arr[i][0]] = arr[i][1];
      return r;
    };
  }
  if (!Array.prototype.at) {
    Array.prototype.at = function (n) {
      n = Math.trunc(n) || 0;
      if (n < 0) n += this.length;
      if (n < 0 || n >= this.length) return undefined;
      return this[n];
    };
  }
  if (!String.prototype.at) {
    String.prototype.at = function (n) {
      n = Math.trunc(n) || 0;
      if (n < 0) n += this.length;
      if (n < 0 || n >= this.length) return undefined;
      return this.charAt(n);
    };
  }
  if (!String.prototype.replaceAll) {
    String.prototype.replaceAll = function (p, r) {
      if (p instanceof RegExp) return this.replace(p, r);
      return this.split(String(p)).join(String(r));
    };
  }
  if (!Array.prototype.flat) {
    Array.prototype.flat = function (d) {
      d = d === undefined ? 1 : Math.trunc(d) || 0;
      var out = [];
      (function walk(a, depth) {
        for (var i = 0; i < a.length; i++) {
          if (Array.isArray(a[i]) && depth > 0) walk(a[i], depth - 1);
          else out.push(a[i]);
        }
      })(this, d);
      return out;
    };
  }
  if (!Array.prototype.flatMap) {
    Array.prototype.flatMap = function (fn, ctx) {
      var out = [];
      for (var i = 0; i < this.length; i++) {
        var v = fn.call(ctx, this[i], i, this);
        if (Array.isArray(v)) out = out.concat(v); else out.push(v);
      }
      return out;
    };
  }
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
      return new Promise(function (res, rej) {
        var arr = Array.from(it), n = arr.length, errs = [], done = false;
        if (!n) { rej(new Error("All promises were rejected")); return; }
        arr.forEach(function (p, i) {
          Promise.resolve(p).then(function (v) { if (!done) { done = true; res(v); } },
            function (e) { errs[i] = e; if (--n === 0 && !done) rej(new Error("All promises were rejected")); });
        });
      });
    };
  }
  if (!w.WeakRef) {
    w.WeakRef = function (o) { this._v = o; };
    w.WeakRef.prototype.deref = function () { return this._v; };
  }
  if (!w.queueMicrotask) {
    w.queueMicrotask = function (fn) { Promise.resolve().then(fn); };
  }
})();
</script>
'''

copied = 0
for root, dirs, files in os.walk(WEB):
    for fn in files:
        if fn.lower().endswith(JS_EXT):
            continue
        src = os.path.join(root, fn)
        rel = os.path.relpath(src, WEB)
        dst = os.path.join(OUT, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)
        copied += 1

print('non-js files copied:', copied)


def inject(rel_html):
    p = os.path.join(OUT, rel_html.replace('/', os.sep))
    if not os.path.exists(p):
        print('  MISSING:', rel_html)
        return
    html = open(p, encoding='utf-8').read()
    if 'ellen-webview-polyfill' in html:
        print('  already patched:', rel_html)
        return
    low = html.lower()
    idx = low.find('<head>')
    if idx == -1:
        print('  no <head>:', rel_html)
        return
    ins = idx + len('<head>')

    # 【charset 必须是 <head> 里第一个标签】
    # 浏览器只扫文档前 1024 字节探测编码。POLYFILL 有 6.3KB，插在 charset 前面
    # 就把它推出窗口，中文机上整页按 GBK 解析 → 内联中文全部乱码。
    # 所以：先摘出 charset 标签钉到 <head> 之后第一位，再在它后面插 POLYFILL。
    import re
    m = re.search(r'<meta[^>]*charset[^>]*>', html, re.I)
    if m:
        tag = m.group(0)
        html = html[:m.start()] + html[m.end():]
        low = html.lower()
        idx = low.find('<head>')
        ins = idx + len('<head>')
    else:
        tag = '<meta charset="UTF-8" />'
    prefix = '\n    ' + tag
    html = html[:ins] + prefix + html[ins:]
    ins += len(prefix)

    out = html[:ins] + '\n' + POLYFILL + html[ins:]
    open(p, 'w', encoding='utf-8', newline='').write(out)
    print('  patched:', rel_html, len(html), '->', len(out))


for h in ['index.html', 'autonomy.html']:
    inject(h)

# 补上 emotion-prompt 等可能被 index 引用的非 js 已复制；列出产物
total = sum(len(f) for _, _, f in os.walk(OUT))
print('web_out files:', total)
