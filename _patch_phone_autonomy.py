# -*- coding: utf-8 -*-
"""把原生后台任务接上：老包 b17 的 EllenAutonomyPlugin.configure() 从来没被 JS 调过。

现象：dumpsys jobscheduler 里 EllenAutonomyJobService 已注册，但没有任何 pending job；
     EllenAutonomy.state() 返回 scheduled:false、lastStatus:"cancelled"。
修法：在 ellen-proactive.js 里补 ensureBackground()，启动/每次 tick 时确认后台任务排上了。

用法：
  python _patch_phone_autonomy.py --check     只校验锚点
  python _patch_phone_autonomy.py --apply     打补丁（备份 .bak-autonomy）
  python _patch_phone_autonomy.py --revert    还原
"""
import sys
import io
import os

sys.stdout.reconfigure(encoding="utf-8")

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "work", "assets", "public")
TARGET = os.path.join(ROOT, "ellen-proactive.js")
BAK = TARGET + ".bak-autonomy"

ANCHOR = "  /* 前台 30 秒一次去问 chunk"

BLOCK = r"""  /* ---- 后台任务：把原生 JobScheduler 排上 ----------------------------------
     b17 的 EllenAutonomyPlugin 是完整实现（327 行 Java，8 个 @PluginMethod 都在），
     但 JS 侧从来没调过 configure()，所以 dumpsys jobscheduler 里一个 pending job 都没有，
     主动消息只能在 app 开着时发。这里补上：读 profileId → configure(enabled:true)。
     已排上（enabled && scheduled）就不重复调。十分钟最多试一次。 */
  var bgAt = 0;
  function readProfileId() {
    return new Promise(function (res) {
      try {
        var r = indexedDB.open("ellen-mobile-data-v1");
        r.onsuccess = function () {
          try {
            var db = r.result;
            var tx = db.transaction("data-profiles", "readonly");
            var q = tx.objectStore("data-profiles").getAll();
            q.onsuccess = function () {
              var a = q.result || [];
              var id = a[0] && (a[0].id || a[0].key);
              res(id || null);
            };
            q.onerror = function () { res(null); };
          } catch (e) { res(null); }
        };
        r.onerror = function () { res(null); };
      } catch (e) { res(null); }
    });
  }

  function ensureBackground(force) {
    var P = g.Capacitor && g.Capacitor.Plugins && g.Capacitor.Plugins.EllenAutonomy;
    if (!P || typeof P.configure !== "function") return Promise.resolve(null);
    var t = Date.now();
    if (!force && bgAt && t - bgAt < 600000) return Promise.resolve(null);
    bgAt = t;
    return readProfileId().then(function (pid) {
      if (!pid) return null;
      return P.state().then(function (s) {
        if (s && s.enabled && s.scheduled) return null;
        return P.configure({ enabled: true, profileId: pid });
      });
    }).catch(function () { return null; });
  }

  g.__ellenAutonomyBg = {
    now: function () { return ensureBackground(true); },
    state: function () {
      var P = g.Capacitor && g.Capacitor.Plugins && g.Capacitor.Plugins.EllenAutonomy;
      return P && P.state ? P.state() : Promise.resolve(null);
    }
  };

"""


def read():
    with io.open(TARGET, encoding="utf-8") as f:
        return f.read()


def write(s):
    with io.open(TARGET, "w", encoding="utf-8", newline="") as f:
        f.write(s)


def slab():
    s = read()
    n = s.count(ANCHOR)
    print("锚点出现次数:", n)
    if n != 1:
        print("!! 锚点不唯一，停止")
        return None
    return s


def main():
    act = sys.argv[1] if len(sys.argv) > 1 else "--check"
    if act == "--check":
        s = slab()
        if s is None:
            return 1
        print("已打补丁:", "ensureBackground" in s)
        return 0
    if act == "--apply":
        s = slab()
        if s is None:
            return 1
        if "ensureBackground" in s:
            print("已经打过，跳过")
            return 0
        if not os.path.exists(BAK):
            with io.open(BAK, "w", encoding="utf-8", newline="") as f:
                f.write(s)
            print("备份 →", BAK)
        s2 = s.replace(ANCHOR, BLOCK + ANCHOR, 1)
        # 启动时排一次
        old = 'if (isFast(load())) { g.__ellenContactMs = FAST_MS; startTick(); }'
        new = ('if (isFast(load())) { g.__ellenContactMs = FAST_MS; startTick(); }\n'
               '  setTimeout(function () { ensureBackground(false); }, 4000);\n'
               '  g.__ellenEnsureBg = ensureBackground;')
        if s2.count(old) != 1:
            print("!! 启动锚点不唯一")
            return 1
        s2 = s2.replace(old, new, 1)
        write(s2)
        print("已应用。新增字节:", len(s2) - len(s))
        return 0
    if act == "--revert":
        if not os.path.exists(BAK):
            print("没有备份可还原")
            return 1
        with io.open(BAK, encoding="utf-8") as f:
            s = f.read()
        write(s)
        print("已还原")
        return 0
    print("用法: --check | --apply | --revert")
    return 1


if __name__ == "__main__":
    sys.exit(main())
