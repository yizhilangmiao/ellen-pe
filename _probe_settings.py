# -*- coding: utf-8 -*-
"""本机 CDP 探针：进设置页，再点进去看二级弹窗的 DOM 到底建没建。

用法：先起静态服务
    cd 艾莲手机版\\创作版\\work\\assets\\public
    python -m http.server 8123 --bind 127.0.0.1
再跑
    python _probe_settings.py
"""
import json
import subprocess
import sys
import time

import requests
import websocket

sys.stdout.reconfigure(encoding="utf-8")

URL = "http://127.0.0.1:8123/index.html"
PORT = 9333
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"

DUMP_JS = r"""
(function(){
  function box(el){
    var r = el.getBoundingClientRect();
    return el.tagName.toLowerCase()
      + '.' + (el.getAttribute('class')||'').split(/\s+/).filter(Boolean).join('.')
      + ' [' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ']'
      + ' z=' + (getComputedStyle(el).zIndex||'-')
      + ' op=' + (getComputedStyle(el).opacity||'-')
      + ' bg=' + (getComputedStyle(el).backgroundColor||'-');
  }
  var out = {};
  ['sheet','modal','dialog','drawer','popover','backdrop','mask','overlay','panel'].forEach(function(k){
    var els = [].slice.call(document.querySelectorAll('[class*="'+k+'"]'));
    els = els.filter(function(e){ return e.getBoundingClientRect().width > 0 || e.getBoundingClientRect().height > 0; });
    out[k] = els.slice(0, 6).map(box);
  });
  out.dialogs = [].slice.call(document.querySelectorAll('dialog')).map(function(d){
    return box(d) + ' open=' + d.open;
  });
  out.bodyChildren = [].slice.call(document.body.children).map(box);
  var app = document.getElementById('app');
  out.appChildren = app ? [].slice.call(app.children).map(box) : [];
  out.startup = app && app.dataset ? app.dataset.startup : '?';
  return JSON.stringify(out, null, 1);
})()
"""


def ev(ws, mid, expr, timeout=10):
    ws.send(json.dumps({"id": mid, "method": "Runtime.evaluate",
                        "params": {"expression": expr, "returnByValue": True,
                                   "awaitPromise": True}}))
    t0 = time.time()
    while time.time() - t0 < timeout:
        m = json.loads(ws.recv())
        if m.get("id") == mid:
            r = m.get("result", {}).get("result", {})
            return r.get("value")
    return None


def main():
    p = subprocess.Popen([EDGE, "--headless=new", "--disable-gpu",
                          "--remote-debugging-port=%d" % PORT,
                          "--user-data-dir=%TEMP%\\ellen_probe_settings",
                          "about:blank"],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(3)
    tgt = None
    for _ in range(20):
        try:
            ts = requests.get("http://127.0.0.1:%d/json/list" % PORT, timeout=2).json()
            for t in ts:
                if t.get("type") == "page":
                    tgt = t
                    break
            if tgt:
                break
        except Exception:
            time.sleep(0.5)
    if not tgt:
        print("连不上 CDP")
        p.kill()
        return 1

    ws = websocket.create_connection(tgt["webSocketDebuggerUrl"], timeout=15)
    mid = 0
    for meth, params in [
        ("Page.enable", {}),
        ("Runtime.enable", {}),
        ("Emulation.setDeviceMetricsOverride",
         {"width": 360, "height": 775, "deviceScaleFactor": 3, "mobile": True}),
    ]:
        mid += 1
        ws.send(json.dumps({"id": mid, "method": meth, "params": params}))
        ws.recv()

    mid += 1
    ws.send(json.dumps({"id": mid, "method": "Page.navigate", "params": {"url": URL}}))

    # 等 ready
    ready = False
    for i in range(30):
        time.sleep(0.5)
        mid += 1
        st = ev(ws, mid, "(()=>{var a=document.getElementById('app');return a&&a.dataset?a.dataset.startup:'?'})()")
        if st == "ready":
            ready = True
            print("[ready] %.1fs" % ((i + 1) * 0.5))
            break
    if not ready:
        print("[WARN] 没到 ready")

    print()
    print("=== 主页 DOM ===")
    print(ev(ws, mid := mid + 1, DUMP_JS))

    # 点底部「设置」
    click_tab = r"""
    (function(){
      var tabs = [].slice.call(document.querySelectorAll('[class*="tab"],[class*="nav"] > *,footer *'));
      var hit = null;
      for (var i=0;i<tabs.length;i++){
        var t = (tabs[i].textContent||'').trim();
        if (t === '设置') { hit = tabs[i]; break; }
      }
      if (!hit) {
        var all = [].slice.call(document.querySelectorAll('button,a,div,span'));
        for (var j=0;j<all.length;j++){
          if (all[j].children.length===0 && (all[j].textContent||'').trim()==='设置'){ hit=all[j]; break; }
        }
      }
      if (!hit) return 'NOTFOUND';
      hit.click();
      return 'CLICKED:' + hit.tagName + '.' + (hit.getAttribute('class')||'');
    })()
    """
    print()
    print("=== 点底部设置 Tab ===")
    print(ev(ws, mid := mid + 1, click_tab))
    time.sleep(1.5)
    print(ev(ws, mid := mid + 1, DUMP_JS))

    # 点设置页里第一个可点条目
    click_item = r"""
    (function(){
      var cands = [].slice.call(document.querySelectorAll('[class*="setting"],[class*="item"],[class*="row"],[class*="cell"],[class*="entry"]'));
      var out = [];
      for (var i=0;i<cands.length && out.length<8;i++){
        var e = cands[i];
        var r = e.getBoundingClientRect();
        if (r.width>0 && r.height>0 && e.children.length<=3){
          out.push(i + ':' + (e.textContent||'').trim().slice(0,20) + ' [' + Math.round(r.width) + 'x' + Math.round(r.height) + '] cls=' + (e.getAttribute('class')||''));
        }
      }
      return out.join('\n');
    })()
    """
    print()
    print("=== 设置页里的候选条目 ===")
    print(ev(ws, mid := mid + 1, click_item))

    print()
    print("=== 点第一个候选 ===")
    print(ev(ws, mid := mid + 1, r"""
    (function(){
      var cands = [].slice.call(document.querySelectorAll('[class*="setting"],[class*="item"],[class*="row"],[class*="cell"]'));
      for (var i=0;i<cands.length;i++){
        var e = cands[i]; var r = e.getBoundingClientRect();
        if (r.width>0 && r.height>0 && e.children.length<=3){ e.click(); return 'CLICKED:' + (e.getAttribute('class')||'') ; }
      }
      return 'NONE';
    })()
    """))
    time.sleep(1.5)
    print(ev(ws, mid := mid + 1, DUMP_JS))

    # 收集 console 错误
    print()
    print("=== 页面错误 ===")
    print(ev(ws, mid := mid + 1, r"""
    (function(){
      var L = window.__ellen_log;
      if (!L || !L.buf) return 'no __ellen_log';
      var errs = L.buf.filter(function(x){ return /\[ERR\]|\[REJ\]/.test(x); });
      return errs.length ? errs.slice(-10).join('\n') : '(无错误)';
    })()
    """))

    ws.close()
    p.kill()
    return 0


if __name__ == "__main__":
    sys.exit(main())
