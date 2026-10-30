# -*- coding: utf-8 -*-
"""
给 web_out/index.html 注入 inline ES5「日志 + 自检面板」（原地修改，幂等）。

两件事：
1. 全程日志采集（比面板更长寿）
   - 拦截 console.log/info/warn/error/debug
   - 资源加载失败 / 运行时错误 / Promise 拒绝
   - 启动里程碑（data-startup 变化、readyState、Capacitor 就绪）
   - 环境快照（UA / 视口 / 内存 / polyfill 生效情况）
   - 存 localStorage（滚动 400 条），下次启动继续累加
2. 面板 + 导出
   - 启动失败：面板自动保留，带 [导出日志] [复制全部] [清空] [关闭]
   - 启动成功：6 秒后自动淡出，用户无感；日志仍留在 localStorage
   - 隐藏入口：连点屏幕左上角 5 次（2 秒内）随时调出

导出顺序（按 WebView 里真正能用的概率降级）：
   navigator.share(带文件) → a[download] → 全屏文本框手动复制
"""
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
INDEX = os.path.join(HERE, "web_out", "index.html")

DIAG = r"""<script>
/*ellen-diag - inline ES5, must run first*/
(function () {
  var KEY = 'ellen.diaglog.v2';
  var MAX = 400;
  var buf = [];

  function pad(n, w) { n = String(n); while (n.length < w) n = '0' + n; return n; }
  function ts() {
    var d = new Date();
    return pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2) + ':' + pad(d.getSeconds(), 2) + '.' + pad(d.getMilliseconds(), 3);
  }
  function ser(x) {
    try {
      if (x === null) return 'null';
      if (x === undefined) return 'undefined';
      var t = typeof x;
      if (t === 'string') return x;
      if (t === 'number' || t === 'boolean') return String(x);
      if (t === 'function') return '[function ' + (x.name || '') + ']';
      if (x instanceof Error) return (x.name || 'Error') + ': ' + x.message + (x.stack ? '\n' + x.stack : '');
      var seen = [];
      return JSON.stringify(x, function (k, v) {
        if (typeof v === 'object' && v !== null) {
          if (seen.indexOf(v) >= 0) return '[circular]';
          seen.push(v);
        }
        if (typeof v === 'function') return '[function]';
        return v;
      });
    } catch (e) { return '[unserializable]'; }
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(buf)); } catch (e) {} }
  function push(level, msg) {
    buf.push(ts() + ' [' + level + '] ' + msg);
    if (buf.length > MAX) buf = buf.slice(buf.length - MAX);
    save();
  }
  try { var raw = localStorage.getItem(KEY); if (raw) buf = JSON.parse(raw) || []; } catch (e) { buf = []; }

  window.__ellen_log = {
    all: function () { return buf.join('\n'); },
    clear: function () { buf = []; save(); },
    count: function () { return buf.length; },
    push: push
  };

  // ---- 拦截 console ----
  var levels = ['log', 'info', 'warn', 'error', 'debug'];
  for (var i = 0; i < levels.length; i++) {
    (function (k) {
      var orig = console[k];
      console[k] = function () {
        try {
          var parts = [];
          for (var j = 0; j < arguments.length; j++) parts.push(ser(arguments[j]));
          push(k.toUpperCase(), parts.join(' '));
        } catch (e) {}
        if (orig) { try { orig.apply(console, arguments); } catch (e) {} }
      };
    })(levels[i]);
  }

  // ---- 错误 ----
  window.addEventListener('error', function (e) {
    try {
      if (e && e.target && e.target.tagName) {
        push('RES', 'FAIL <' + String(e.target.tagName).toLowerCase() + '> ' + (e.target.src || e.target.href || 'inline'));
      } else {
        push('ERR', ((e && e.message) || '')
          + ' @ ' + String((e && e.filename) || '').split('/').pop()
          + ':' + ((e && e.lineno) || 0) + ':' + ((e && e.colno) || 0)
          + (((e && e.error && e.error.stack) ? '\n' + e.error.stack : '')));
      }
    } catch (x) {}
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    try { push('REJ', ser(e && e.reason)); } catch (x) {}
  });

  // ---- 环境快照 ----
  push('ENV', 'UA=' + navigator.userAgent);
  push('ENV', 'href=' + location.href + ' proto=' + location.protocol);
  push('ENV', 'screen=' + screen.width + 'x' + screen.height + ' dpr=' + (window.devicePixelRatio || 0));
  push('ENV', 'Capacitor=' + (window.Capacitor ? 'yes' : 'no')
    + ' native=' + (window.Capacitor && window.Capacitor.isNativePlatform ? window.Capacitor.isNativePlatform() : 'n/a'));
  push('ENV', 'polyfill structuredClone=' + (typeof structuredClone)
    + ' replaceChildren=' + (typeof (window.Element && Element.prototype && Element.prototype.replaceChildren))
    + ' Object.hasOwn=' + (typeof Object.hasOwn));
  push('ENV', 'readyState=' + document.readyState);

  // ---- 视口快照（延迟 3 秒，等 .ellen-app 渲染完）----
  // 界面上下留黑边那类问题都出在这儿：CSS 的 100dvh 在 Chrome 83 无效，
  // 页面高度自举失败后 --el-viewport-* 会读到偏小的值。
  function vp(name) {
    try {
      var app = document.querySelector('.ellen-app') || document.getElementById('app');
      if (!app) { push('VP', name + ' .ellen-app 未找到'); return; }
      var cs = getComputedStyle(app);
      var r = app.getBoundingClientRect();
      var vv = window.visualViewport;
      push('VP', name
        + ' inner=' + window.innerWidth + 'x' + window.innerHeight
        + ' vv=' + (vv ? (Math.round(vv.width) + 'x' + Math.round(vv.height)
            + ' top=' + Math.round(vv.offsetTop) + ' scale=' + vv.scale) : 'n/a'));
      push('VP', name
        + ' var height=' + (cs.getPropertyValue('--el-viewport-height') || '(空)')
        + ' top=' + (cs.getPropertyValue('--el-viewport-top') || '(空)')
        + ' bottom=' + (cs.getPropertyValue('--el-viewport-bottom') || '(空)'));
      push('VP', name
        + ' .ellen-app rect top=' + Math.round(r.top) + ' h=' + Math.round(r.height)
        + ' css-height=' + cs.height + ' css-top=' + cs.top
        + ' scrollH=' + document.documentElement.scrollHeight);
    } catch (x) { push('VP', name + ' err ' + ser(x)); }
  }
  setTimeout(function () { vp('t3s'); }, 3000);
  setTimeout(function () { vp('t8s'); }, 8000);

  // ---- 启动里程碑 ----
  var lastStartup = null;
  function pollStartup() {
    var app = document.getElementById('app');
    var s = (app && app.dataset) ? app.dataset.startup : null;
    if (s !== lastStartup) {
      lastStartup = s;
      push('BOOT', 'data-startup=' + s + ' readyState=' + document.readyState);
    }
    if (document.readyState !== pollStartup._rs) {
      pollStartup._rs = document.readyState;
      push('BOOT', 'readyState=' + document.readyState);
    }
  }
  setInterval(pollStartup, 200);
  setTimeout(pollStartup, 0);

  // ---- 报告 ----
  function buildReport() {
    var lines = [];
    lines.push('===== Ellen 诊断日志 =====');
    lines.push('生成时间: ' + new Date().toISOString());
    lines.push('本地时间: ' + new Date().toString());
    lines.push('UA: ' + navigator.userAgent);
    lines.push('href: ' + location.href);
    lines.push('readyState: ' + document.readyState);
    lines.push('Capacitor: ' + (window.Capacitor ? 'yes' : 'no'));
    lines.push('structuredClone: ' + (typeof structuredClone));
    lines.push('replaceChildren: ' + (typeof (window.Element && Element.prototype && Element.prototype.replaceChildren)));
    lines.push('log 条数: ' + buf.length);
    lines.push('==========================');
    lines.push('');
    lines.push(buf.join('\n'));
    return lines.join('\n');
  }

  // ---- 导出 ----
  function downloadText(text, name) {
    try {
      var blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.style.position = 'fixed';
      a.style.left = '-9999px';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(url); if (a.parentNode) a.parentNode.removeChild(a); }, 2000);
      return true;
    } catch (e) {
      return false;
    }
  }

  function showRaw(text) {
    var ov = document.createElement('div');
    ov.setAttribute('style', 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483647;'
      + 'background:#111;color:#ddd;padding:10px;display:flex;flex-direction:column');
    var bar = document.createElement('div');
    bar.setAttribute('style', 'flex:0 0 auto;padding-bottom:6px');
    var btnCopy = document.createElement('button');
    btnCopy.textContent = '全选并复制';
    btnCopy.setAttribute('style', 'font-size:14px;padding:6px 10px;margin-right:8px');
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('style', 'flex:1 1 auto;width:100%;box-sizing:border-box;font:11px/1.4 monospace;'
      + 'background:#000;color:#9f9;border:1px solid #444;padding:6px');
    btnCopy.onclick = function () {
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, text.length);
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) {}
      btnCopy.textContent = ok ? '已复制，去粘贴' : '复制失败，请长按全选';
    };
    var btnClose = document.createElement('button');
    btnClose.textContent = '关闭';
    btnClose.setAttribute('style', 'font-size:14px;padding:6px 10px');
    btnClose.onclick = function () { if (ov.parentNode) ov.parentNode.removeChild(ov); };
    bar.appendChild(btnCopy);
    bar.appendChild(btnClose);
    ov.appendChild(bar);
    ov.appendChild(ta);
    document.body.appendChild(ov);
    setTimeout(function () { try { ta.focus(); ta.select(); ta.setSelectionRange(0, text.length); } catch (e) {} }, 100);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { alert('日志已复制到剪贴板'); },
        function () { showRaw(text); }
      );
      return;
    }
    showRaw(text);
  }

  function exportLog() {
    var text = buildReport();
    var name = 'ellen-log-' + (new Date().getTime()) + '.txt';
    try {
      if (window.File && window.File && navigator.canShare) {
        var f = new File([text], name, { type: 'text/plain' });
        if (navigator.canShare({ files: [f] })) {
          navigator.share({ files: [f], title: name }).catch(function () {
            if (!downloadText(text, name)) showRaw(text);
          });
          return;
        }
      }
    } catch (e) {}
    if (!downloadText(text, name)) showRaw(text);
    else push('SYS', '导出文件已触发下载: ' + name);
  }

  // ---- 面板 ----
  var errCount = 0;
  var resFail = 0;
  var d = document.createElement('div');
  d.id = '__ellen_diag';
  d.setAttribute('style', 'position:fixed;left:0;top:0;right:0;z-index:2147483646;'
    + 'background:#fff;color:#111;font:12px/1.45 monospace;padding:8px 10px 10px;'
    + 'white-space:pre-wrap;word-break:break-all;max-height:62vh;overflow:auto;'
    + 'border-bottom:3px solid #d00;box-shadow:0 2px 8px rgba(0,0,0,.5);'
    + 'transition:opacity .4s');

  var bar = document.createElement('div');
  bar.setAttribute('style', 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:6px');

  var title = document.createElement('span');
  title.textContent = '[1] JS 引擎已启动';
  title.setAttribute('style', 'flex:1 1 auto;font-weight:bold');
  bar.appendChild(title);

  function mkBtn(label, color, fn) {
    var b = document.createElement('button');
    b.textContent = label;
    b.setAttribute('style', 'font-size:12px;padding:4px 8px;border:1px solid ' + color
      + ';background:#fff;color:' + color + ';border-radius:4px;line-height:1.2');
    b.onclick = fn;
    bar.appendChild(b);
    return b;
  }

  mkBtn('导出日志', '#0a7', exportLog);
  mkBtn('复制全部', '#07a', function () { copyText(buildReport()); });
  mkBtn('清空', '#888', function () {
    if (confirm('清空已记录的日志？')) { window.__ellen_log.clear(); body.textContent = ''; log('日志已清空'); }
  });
  mkBtn('关闭', '#d00', function () { d.style.display = 'none'; });
  d.appendChild(bar);

  var body = document.createElement('div');
  d.appendChild(body);

  function log(s) { body.textContent += s + '\n'; }
  function mount() {
    if (!document.body) { setTimeout(mount, 30); return; }
    document.body.appendChild(d);
  }
  mount();

  // 面板里同步显示错误
  var origErr = console.error;
  // 注意：e.target 有 tagName 的是「资源加载失败」（img/link/script），
  // 这类失败很常见（可选样式、装饰图），不能当成启动失败，否则会把正常启动的面板强行留住。
  // 所以资源失败单独计 resFail，只有真正的脚本异常与 Promise 拒绝才进 errCount。
  window.addEventListener('error', function (e) {
    var t = e.target;
    if (t && t.tagName && t !== window) {
      resFail++;
      log('[资源失败] <' + String(t.tagName).toLowerCase() + '> ' + (t.src || t.href || 'inline'));
    } else {
      errCount++;
      log('[脚本错误] ' + (e.message || '') + ' @ ' + String(e.filename || '').split('/').pop() + ':' + e.lineno + ':' + e.colno);
    }
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    errCount++;
    log('[Promise 拒绝] ' + ((r && (r.stack || r.message)) || ser(r)));
  });

  function probe(f) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', f, false);
      x.send(null);
      log('[XHR] ' + f + ' -> ' + x.status + ' type=' + (x.getResponseHeader('Content-Type') || '?') + ' len=' + (x.responseText || '').length);
    } catch (err) {
      log('[XHR 失败] ' + f + ' -> ' + (err && err.message));
    }
  }

  function tag(name, fn) {
    var ok = false;
    try { ok = fn(); } catch (e) { ok = false; }
    return '[' + (ok ? 'OK' : 'MISS') + '] ' + name;
  }

  setTimeout(function () {
    log('');
    log('UA: ' + navigator.userAgent);
    log('href: ' + location.href + '  ' + location.protocol);
    log('');
    log('polyfill: '
      + tag('structuredClone', function () { return typeof structuredClone === 'function'; })
      + '  ' + tag('replaceChildren', function () { return typeof Element.prototype.replaceChildren === 'function'; })
      + '  ' + tag('Object.hasOwn', function () { return typeof Object.hasOwn === 'function'; })
      + '  ' + tag('String.at', function () { return typeof String.prototype.at === 'function'; })
      + '  ' + tag('replaceAll', function () { return typeof String.prototype.replaceAll === 'function'; }));
    log('');
    probe('assets/main-Egmribf1.css');
    probe('ellen-startup-opening.js');
    probe('assets/main-C8dMeyqt.js');
    probe('assets/storage-worker-CVMjPGme.js');
    log('');
    log('--- 最近 30 条日志 ---');
    var tail = buf.slice(buf.length > 30 ? buf.length - 30 : 0);
    for (var i = 0; i < tail.length; i++) log(tail[i]);
  }, 50);

  setTimeout(function () {
    var boot = document.querySelector('.el-boot-wait');
    var app = document.getElementById('app');
    var ds = (app && app.dataset) || {};
    var startup = ds.startup || '';
    // 判定只看 data-startup：ready 就是成功。
    // 资源 404 与「最近 30 条里的告警」都不影响启动，不能拿来否决。
    var ok = (startup === 'ready');
    if (ok) {
      d.style.opacity = '0';
      setTimeout(function () { d.style.display = 'none'; }, 450);
      push('BOOT', '启动正常，面板已隐藏（资源失败 ' + resFail + ' 个，脚本错误 ' + errCount + ' 个）');
      return;
    }
    push('BOOT', '启动未完成 startup=' + startup + ' code=' + (ds.startupCode || '-')
      + ' stage=' + (ds.startupStage || '-') + ' err=' + errCount + ' res=' + resFail + ' boot=' + !!boot);
    log('');
    log('--- 面板保留 ---');
    log('data-startup      : ' + (startup || '(空)'));
    log('data-startupCode  : ' + (ds.startupCode || '(空)'));
    log('data-startupStage : ' + (ds.startupStage || '(空)'));
    log('脚本错误数        : ' + errCount);
    log('资源失败数        : ' + resFail + '（不影响启动，仅供参考）');
    log('#app 当前文本      : ' + (app ? String(app.textContent || '').replace(/\s+/g, ' ').slice(0, 160) : '(无)'));
    log('console 条数       : ' + buf.length + '（点「导出日志」可取全部）');
    log('script 标签数: ' + document.scripts.length);
    for (var i = 0; i < document.scripts.length; i++) {
      var s = document.scripts[i];
      log('  #' + i + ' type=' + (s.type || 'classic') + ' ' + (s.src ? s.src.split('/').pop() : 'inline'));
    }
    log('');
    log('点右上角「导出日志」，把文件发给开发者。');
  }, 6000);

  // ---- 隐藏入口：连点左上角 5 次 ----
  var taps = [];
  document.addEventListener('touchstart', function (e) {
    var t = e.touches && e.touches[0];
    if (!t) return;
    if (t.clientX < 80 && t.clientY < 80) {
      var now = Date.now();
      taps.push(now);
      taps = taps.filter(function (v) { return now - v < 2000; });
      if (taps.length >= 5) {
        taps = [];
        d.style.display = '';
        d.style.opacity = '1';
        log('（手动调出，' + buf.length + ' 条日志）');
      }
    }
  }, { passive: true });
  document.addEventListener('click', function (e) {
    if (e.clientX < 80 && e.clientY < 80) {
      var now = Date.now();
      taps.push(now);
      taps = taps.filter(function (v) { return now - v < 2000; });
      if (taps.length >= 5) {
        taps = [];
        d.style.display = '';
        d.style.opacity = '1';
        log('（手动调出，' + buf.length + ' 条日志）');
      }
    }
  });
})();
</script>
"""


def strip_old(html):
    if "ellen-diag" not in html:
        return html, False
    start = html.find("/*ellen-diag")
    if start < 0:
        return html, False
    s = html.rfind("<script", 0, start)
    if s < 0:
        return html, False
    e = html.find("</script>", start)
    if e < 0:
        return html, False
    return html[:s] + html[e + len("</script>"):], True


def main():
    if not os.path.exists(INDEX):
        print("找不到:", INDEX)
        return 1
    with open(INDEX, "r", encoding="utf-8", newline="") as f:
        html = f.read()
    before = len(html.encode("utf-8"))

    html, removed = strip_old(html)
    if removed:
        print("旧诊断脚本已移除")

    # 【charset 必须落在文档前 1024 字节内】
    # 浏览器只扫前 1024 字节探测编码。polyfill(6.3KB) 和 DIAG(11KB) 都在 <head> 里，
    # 会把 <meta charset> 推出探测窗口 → 整页按系统默认编码（中文机 = GBK）解析 → 中文全是乱码。
    # 所以先把它摘出来、钉到 <head> 之后第一位，再把 DIAG 插在它后面。
    import re as _re

    m = _re.search(r"<meta[^>]*charset[^>]*>", html, _re.I)
    tag = m.group(0) if m else '<meta charset="UTF-8" />'
    if m:
        html = html[: m.start()] + html[m.end():]

    idx = html.find("<head>")
    if idx < 0:
        print("找不到 <head>")
        return 1
    ins = idx + len("<head>")
    head_ins = "\n    " + tag
    html = html[:ins] + head_ins + html[ins:]
    pos = ins + len(head_ins)
    print("charset 钉到 head 后 (offset %d)" % pos)

    html = html[:pos] + "\n" + DIAG + html[pos:]

    with open(INDEX, "w", encoding="utf-8", newline="") as f:
        f.write(html)
    after = len(html.encode("utf-8"))

    print("index.html: %d -> %d bytes" % (before, after))
    print("含 polyfill:", "ellen-webview-polyfill" in html)
    print("含 diag   :", "ellen-diag" in html)
    print("含 导出日志:", "导出日志" in html)
    print("含 隐藏入口:", "连点左上角" in html or "手动调出" in html)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
