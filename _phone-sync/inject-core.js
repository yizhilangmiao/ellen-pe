/* ============================================================================
 * ellen-sync core  ·  手机版注入模块骨架（复制成 inject-<feat>.js 再改）
 * ----------------------------------------------------------------------------
 * 落点：work/assets/public/ellen-startup-opening.js 末尾
 * 提供：哨兵 / 本地状态 / 安全开库 / 消息读取 / DOM 与样式注入 / 一条启动链
 * 铁律：不新增 APK 条目；不写宿主 store；不升级 DB 版本；不动宿主 DOM 结构
 * ========================================================================== */
(function () {
  "use strict";
  if (typeof window === "undefined" || typeof document === "undefined") return;
  var MOD = "__ellenSync";                 // ← 改成自己的名字
  if (window[MOD]) return;
  window[MOD] = { version: "0.1.0", at: Date.now() };

  /* ------------------------------ 本地状态（自己一个键，不碰宿主的） */
  var STORE_KEY = "ellen.mobile.__feat__.v1";   // ← 改键名

  function load() {
    var raw = null;
    try {
      raw = window.localStorage.getItem(STORE_KEY);
    } catch (e) {}
    var st = null;
    if (raw) {
      try {
        st = JSON.parse(raw);
      } catch (e) {}
    }
    return st && typeof st === "object" ? st : {};
  }

  function save(st) {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify(st));
    } catch (e) {}
  }

  /* ------------------------------ 安全开库
   * 坑：裸 indexedDB.open(name) 在库不存在时会建一个空库 v1，之后宿主按
   * oldVersion=1 走迁移会直接判 MISSING_PERSISTED_STATE，把新装用户搞坏。
   * 所以 onupgradeneeded 里必须 abort + deleteDatabase，并用定时器兜底 resolve。
   */
  var DB_NAME = "ellen-mobile-data-v1";

  function peekDb() {
    return new Promise(function (resolve) {
      var settled = false;
      var finish = function (db) {
        if (settled) return;
        settled = true;
        resolve(db || null);
      };
      var req;
      try {
        req = window.indexedDB.open(DB_NAME);
      } catch (e) {
        return finish(null);
      }
      var created = false;
      req.onupgradeneeded = function () {
        created = true;
        try {
          req.transaction.abort();
        } catch (e) {}
      };
      req.onsuccess = function () {
        var db = req.result;
        if (created) {
          try {
            db.close();
          } catch (e) {}
          try {
            window.indexedDB.deleteDatabase(DB_NAME);
          } catch (e) {}
          return finish(null);
        }
        finish(db);
      };
      req.onerror = req.onblocked = function () {
        finish(null);
      };
      window.setTimeout(function () {
        finish(null);
      }, 2500);
    });
  }

  /* ------------------------------ 读消息 head（只读，data-heads/messageTime） */
  function readHeads(db, profileId) {
    return new Promise(function (resolve) {
      var out = [];
      var tx;
      try {
        tx = db.transaction(["data-heads"], "readonly");
      } catch (e) {
        return resolve(out);
      }
      var req;
      try {
        req = tx
          .objectStore("data-heads")
          .index("messageTime")
          .openCursor(window.IDBKeyRange.bound([profileId], [profileId, "\uffff"], false, false));
      } catch (e) {
        try {
          req = tx.objectStore("data-heads").openCursor();
        } catch (e2) {
          return resolve(out);
        }
      }
      req.onsuccess = function () {
        var cur = req.result;
        if (!cur) return;
        var v = cur.value;
        if (v && v.kind === "message" && !v.deleted) out.push(v);
        try {
          cur.continue();
        } catch (e) {}
      };
      req.onerror = function () {
        resolve(out);
      };
      tx.oncomplete = tx.onabort = function () {
        resolve(out);
      };
    });
  }

  function profileId() {
    var keys = ["ellen-mobile-active-profile", "ellen.mobile.active-profile"];
    for (var i = 0; i < keys.length; i++) {
      try {
        var v = window.localStorage.getItem(keys[i]);
        if (v && v.length > 1 && v.length < 120 && v.indexOf("{") < 0) return v;
      } catch (e) {}
    }
    return null;
  }

  /* ------------------------------ DOM / 样式 / 工具 */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }

  function injectCss(id, css) {
    if (document.getElementById(id)) return;
    var s = document.createElement("style");
    s.id = id;
    s.type = "text/css";
    s.appendChild(document.createTextNode(css));
    (document.head || document.documentElement).appendChild(s);
  }

  function reduced() {
    try {
      return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    } catch (e) {
      return false;
    }
  }

  function toast(msg, root) {
    var t = root || document.querySelector(".els-toast");
    if (!t) return;
    t.textContent = msg;
    t.setAttribute("data-show", "1");
    window.setTimeout(function () {
      t.setAttribute("data-show", "0");
    }, 1800);
  }

  /* ------------------------------ 主流程（照这个形状写） */
  var SYS = { busy: false, detail: { ok: false, reason: "idle" } };

  function sync() {
    if (SYS.busy) return Promise.resolve(null);
    SYS.busy = true;
    return peekDb()
      .then(function (db) {
        if (!db) {
          SYS.detail = { ok: false, reason: "no-db" };
          return null;
        }
        var pid = profileId();
        if (!pid) {
          try {
            db.close();
          } catch (e) {}
          SYS.detail = { ok: false, reason: "no-profile" };
          return null;
        }
        return readHeads(db, pid).then(function (heads) {
          var st = load();
          st.scanned = heads.length;
          st.at = new Date().toISOString();
          save(st);
          SYS.detail = { ok: true, reason: "synced", scanned: heads.length };
          try {
            db.close();
          } catch (e) {}
          render();
          return st;
        });
      })
      .catch(function (err) {
        SYS.detail = { ok: false, reason: (err && err.message) || "error" };
        return null;
      })
      .then(function (v) {
        SYS.busy = false;
        return v;
      });
  }

  /* ------------------------------ UI 挂点
   * 自建 fixed 元素挂到 body，别 append 进宿主容器（SPA 重渲染会把你的节点扔掉）。
   */
  var dom = {};

  function build() {
    if (dom.root) return;
    injectCss(
      "els-style",
      [
        ".els-fab{position:fixed;right:14px;bottom:118px;z-index:70;width:46px;height:46px;border-radius:50%;",
        "border:1px solid rgba(214,160,180,.5);background:rgba(28,32,38,.92);color:#f2e9ec;",
        "display:flex;align-items:center;justify-content:center;box-shadow:0 6px 18px rgba(0,0,0,.38);}",
        ".els-toast{position:fixed;left:50%;bottom:22%;transform:translateX(-50%);z-index:73;",
        "background:rgba(20,23,28,.94);color:#e6e1dd;border:1px solid #2c313a;border-radius:999px;",
        "padding:9px 16px;font:400 12.5px/1 system-ui,sans-serif;opacity:0;transition:opacity .2s ease;pointer-events:none;}",
        ".els-toast[data-show='1']{opacity:1;}",
        "@media (prefers-reduced-motion:reduce){.els-toast{transition-duration:.12s!important;}}",
      ].join("")
    );
    var fab = el("button", "els-fab", "·");
    fab.setAttribute("aria-label", "__TITLE__");
    fab.addEventListener("click", function () {
      sync().then(function () {
        render();
        toast("扫到 " + (SYS.detail.scanned || 0) + " 条", document.querySelector(".els-toast"));
      });
    });
    var t = el("div", "els-toast", "");
    document.body.appendChild(fab);
    document.body.appendChild(t);
    dom.root = fab;
    dom.fab = fab;
    dom.toast = t;
  }

  function render() {
    if (!dom.fab) return;
    dom.fab.setAttribute("data-empty", SYS.detail.ok ? "0" : "1");
  }

  function start() {
    build();
    render();
    window.setTimeout(function () {
      sync();
    }, 4000); /* 启动后静默扫一次，别抢宿主首屏 */
  }

  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });

  /* ------------------------------ 对外调试口（真机验收靠它） */
  window[MOD].sync = sync;
  window[MOD].state = function () {
    return { detail: SYS.detail, local: load() };
  };
  window[MOD].debugReset = function () {
    try {
      window.localStorage.removeItem(STORE_KEY);
    } catch (e) {}
    return true;
  };
})();
