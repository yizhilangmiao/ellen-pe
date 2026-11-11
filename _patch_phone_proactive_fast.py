# -*- coding: utf-8 -*-
"""手机版主动消息 · 快速验证补丁（fast 模式 = 30 秒一次）

目的：把「主动消息检查间隔」从 k(false) 的 30 分钟压到 30 秒，并把门控的
4 小时静默期 / 每日上限 / 最小间隔一起放开，好在 50 分钟的观察窗口里
看到「能不能真的发出去」，而不是等半小时才轮到一次判断。

设计：全部走一个运行期开关 globalThis.__ellenContactMs（默认不设 → 原行为不变）
和 localStorage['ellen.proactive.v2'].fast。
不打补丁时 app 表现一个字都不变；开 fast 才生效。

用法:
    python _patch_phone_proactive_fast.py --check     # 只报各处是否唯一、是否已打
    python _patch_phone_proactive_fast.py --apply
    python _patch_phone_proactive_fast.py --revert
"""
import argparse
import io
import os
import re
import sys

sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
PUB = os.path.join(HERE, "work", "assets", "public")
CHUNK = os.path.join(PUB, "assets", "service-DGjhUELY.js")
GATE = os.path.join(PUB, "ellen-proactive.js")
BAK = ".bak-fast"

FAST_MS = 30000

# ---- chunk 里的间隔调用点：精确串，各出现 1 次 ----
INTERVAL_SITES = [
    "a(false, n2, r2)",
    "a(false, o2, s2)",
    "a(false, r2, o2)",
    "N(false, r2, i2)",
    "N(false, r2, o2)",
]
K_SITE = "k(false)"
TICK_ANCHOR = "async function g2()"
TICK_INJECT = "\n  globalThis.__ellenContactTick = function () { return g2(); };"

# 门控通过后的原文（唯一），dry-run 短路就插在它后面
DRY_SITE = ("if (globalThis.__ELLEN_PROACTIVE_GATE__ && "
            "!globalThis.__ELLEN_PROACTIVE_GATE__(t3, c3)) "
            "return { status: `gate-skip` };")
DRY_INJECT = ("\n    if (globalThis.__ellenProactiveDryRun) "
              "return { status: `dry-run-pass`, at: c3 };")

# 能聊判断 Ry：dry-run 时强制放行，否则「模型没配」永远走不到门控
RY_HEAD = "var Ry = (e8) => "
RY_BODY_OLD = ("(e8 == null ? void 0 : e8.enabled) === true && "
               "e8.modelConfigured === true && !e8.busy && !e8.loading && "
               "!e8.retry && typeof e8.threadId == `string` && !!e8.threadId;")
RY_BODY_NEW = ("globalThis.__ellenProactiveDryRun ? true : (" + RY_BODY_OLD[:-1] + ")")

# 首轮冷却 f2 在模块加载时就算死了（那时 __ellenContactMs 还没设），dry-run 要绕过它
UNAVAIL_OLD = "if (l2 || c3 < f2 || !Ry(t3)) return { status: `unavailable` };"
UNAVAIL_NEW = ("if (l2 || (!globalThis.__ellenContactMs && !globalThis.__ellenProactiveDryRun && c3 < f2) || !Ry(t3)) "
               "return { status: `unavailable` };")

GATE_FAST_BLOCK = """
  /* ---- fast 模式（验证用）：把间隔压到 FAST_MS 秒 ------------------------
     开：__ellenProactiveFast.on()   关：__ellenProactiveFast.off()
     只影响本地预筛 + chunk 里 dueAt/nextAt 的间隔，不改任何原生逻辑。 */
  var FAST_MS = %d;
  function isFast(cfg) { return !!(cfg && cfg.fast); }
  g.__ellenProactiveFast = {
    ms: FAST_MS,
    on: function () {
      var c = load(); c.fast = true; save(c);
      g.__ellenContactMs = FAST_MS;
      startTick();
      return FAST_MS;
    },
    off: function () {
      var c = load(); delete c.fast; save(c);
      try { delete g.__ellenContactMs; } catch (e) { g.__ellenContactMs = undefined; }
      if (g.__ellenTickTimer) { clearInterval(g.__ellenTickTimer); g.__ellenTickTimer = null; }
      return false;
    },
    state: function () { return { fast: isFast(load()), ms: g.__ellenContactMs || null, ticking: !!g.__ellenTickTimer }; }
  };

  /* 前台 30 秒一次去问 chunk「现在该不该发」。chunk 自己带 busy 锁和
     closed 标记，重复调用是安全的；chunk 还没加载完时静默跳过。 */
  function startTick() {
    if (g.__ellenTickTimer) return;
    g.__ellenTickTimer = setInterval(function () {
      try {
        if (!g.__ellenContactMs) return;
        var f = g.__ellenContactTick;
        if (typeof f !== "function") return;
        var p = f();
        if (p && typeof p.catch === "function") p.catch(function () {});
      } catch (e) {}
    }, FAST_MS);
  }
  if (isFast(load())) { g.__ellenContactMs = FAST_MS; startTick(); }
""" % FAST_MS


def read(path):
    with io.open(path, encoding="utf-8") as f:
        return f.read()


def write(path, text):
    with io.open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)


def brace_end(s, start):
    """从 s[start] 的 '{' 开始做括号配平，返回匹配 '}' 的下标。"""
    i = s.index("{", start)
    depth = 0
    n = len(s)
    while i < n:
        c = s[i]
        if c in "\"'`":
            q = c
            i += 1
            while i < n:
                if s[i] == "\\":
                    i += 2
                    continue
                if s[i] == q:
                    break
                i += 1
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    raise RuntimeError("括号配平失败")


def plan_chunk(src):
    """返回 (新文本, 报告行列表)。已打过则原样返回。"""
    rep = []
    if "__ellenContactTick" in src:
        rep.append("  已打：__ellenContactTick 存在")
        return src, rep

    out = src
    for site in INTERVAL_SITES:
        c = out.count(site)
        if c != 1:
            raise RuntimeError("间隔调用点不唯一: %r 命中 %d 次" % (site, c))
        out = out.replace(site, "(globalThis.__ellenContactMs||%s)" % site)
        rep.append("  间隔 %-22s → 受 __ellenContactMs 控制" % site)

    c = out.count(K_SITE)
    if c != 4:
        raise RuntimeError("k(false) 命中 %d 次，预期 4" % c)
    out = out.replace(K_SITE, "(globalThis.__ellenContactMs||%s)" % K_SITE)
    rep.append("  间隔 k(false) ×%d           → 受 __ellenContactMs 控制（含 readyAt/复查间隔）" % c)

    m = re.search(r"async function g2\(\)\s*\{\s*if \(l2\)\s*return\s*\{\s*status:\s*`closed`", out)
    if not m:
        raise RuntimeError("找不到 g2()（带 l2/closed 标记的那个）")
    st = m.start()
    end = brace_end(out, st)
    out = out[:end + 1] + TICK_INJECT + out[end + 1:]
    rep.append("  暴露 globalThis.__ellenContactTick（= g2）")

    # 空网演练：过了门控就返回，不调模型 —— 用于「模型还没配」时验证 30 秒节奏
    c = out.count(DRY_SITE)
    if c != 1:
        raise RuntimeError("门控调用点不唯一: %d" % c)
    out = out.replace(DRY_SITE, DRY_SITE + DRY_INJECT)
    rep.append("  门控之后加 __ellenProactiveDryRun 短路")

    ry_old = RY_HEAD + RY_BODY_OLD
    c = out.count(ry_old)
    if c != 1:
        raise RuntimeError("Ry 定义不唯一: %d" % c)
    out = out.replace(ry_old, RY_HEAD + RY_BODY_NEW)
    rep.append("  Ry 加 __ellenProactiveDryRun 放行（模型没配也能走到门控）")

    c = out.count(UNAVAIL_OLD)
    if c != 1:
        raise RuntimeError("unavailable 判断不唯一: %d" % c)
    out = out.replace(UNAVAIL_OLD, UNAVAIL_NEW)
    rep.append("  dry-run 绕过首轮冷却 f2（它按加载时的旧间隔算死了）")
    return out, rep


def plan_gate(src):
    rep = []
    if "__ellenProactiveFast" in src:
        rep.append("  已打：__ellenProactiveFast 存在")
        return src, rep

    if "if (gap < QUIET_GAP_MS) return" not in src:
        raise RuntimeError("找不到 quiet 门槛")
    src = src.replace(
        "if (gap < QUIET_GAP_MS) return { allow: false, score: 0, reason: \"quiet-too-soon\", signals: sig };",
        "if (gap < needGap) return { allow: false, score: 0, reason: \"quiet-too-soon\", signals: sig };")
    rep.append("  quiet 门槛 → needGap（fast 时 30s）")

    if "if (groups >= p.dailyGroups) return" not in src:
        raise RuntimeError("找不到每日上限")
    src = src.replace(
        "if (groups >= p.dailyGroups) return",
        "if (groups >= cap) return")
    rep.append("  每日上限 → cap（fast 时基本不设限）")

    if "now - lastPro < p.minGapMs" not in src:
        raise RuntimeError("找不到最小间隔")
    src = src.replace("now - lastPro < p.minGapMs", "now - lastPro < gapMs")
    rep.append("  最小间隔 → gapMs（fast 时 30s）")

    # 没有任何「用户上次说话时间」时，真实逻辑直接判 quiet-too-soon。
    # 验证期没有真实对话，这里在 fast 模式下当成「12 小时没说话」放过去。
    no_gap = ('if (gap == null) return { allow: false, score: 0, reason: "quiet-too-soon", '
              'signals: sig };')
    if no_gap not in src:
        raise RuntimeError("找不到 gap==null 分支")
    src = src.replace(no_gap,
        'if (gap == null && fast) { gap = 12 * 3600e3; sig.gapAssumed = true; '
        'sig.gapHours = 12; }\n'
        '    ' + no_gap)
    rep.append("  没有 latestUser 时 fast 当 12 小时放过去")

    marker = "    var cfg = load();\n    var pname = presetName(cfg);"
    if marker not in src:
        raise RuntimeError("找不到 evaluate 头部")
    src = src.replace(marker,
        "    var cfg = load();\n"
        "    var fast = isFast(cfg);\n"
        "    var needGap = fast ? FAST_MS : QUIET_GAP_MS;\n"
        "    var gapMs = fast ? FAST_MS : null;\n"
        "    var cap = null;\n"
        "    var pname = presetName(cfg);")
    rep.append("  evaluate 头部注入 fast 派生量")

    # gapMs / cap 依赖 p（档位）→ 在 p 赋值后补
    if "var p = PRESETS[pname];" not in src:
        raise RuntimeError("找不到档位取值")
    src = src.replace("var p = PRESETS[pname];",
        "var p = PRESETS[pname];\n"
        "    if (!fast) gapMs = p.minGapMs;\n"
        "    cap = fast ? 1e9 : p.dailyGroups;")
    rep.append("  档位取值后补 gapMs / cap")

    # threshold：fast 时不看分数
    src = src.replace(
        "if (score >= p.threshold)",
        "if (score >= (fast ? 0 : p.threshold))")
    src = src.replace(
        "reason: (score >= p.threshold) ? \"scored\" : \"below-threshold\"",
        "reason: (score >= (fast ? 0 : p.threshold)) ? \"scored\" : \"below-threshold\"")
    rep.append("  打分门槛 → fast 时不拦")

    # 追加 fast 控制块
    tail = "\n})();\n"
    if not src.rstrip().endswith("})();"):
        raise RuntimeError("ellen-proactive.js 结尾不是 IIFE")
    idx = src.rstrip().rfind("})();")
    src = src[:idx] + GATE_FAST_BLOCK + "\n" + src[idx:]
    rep.append("  追加 __ellenProactiveFast / 30 秒 tick")
    return src, rep


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--revert", action="store_true")
    a = ap.parse_args()

    if a.revert:
        for p in (CHUNK, GATE):
            b = p + BAK
            if os.path.exists(b):
                os.replace(b, p)
                print("[revert] %s" % os.path.basename(p))
            else:
                print("[skip]   %s 没有备份" % os.path.basename(p))
        return

    print("[chunk] %s  %.0f KB" % (os.path.basename(CHUNK), os.path.getsize(CHUNK) / 1024.0))
    src = read(CHUNK)
    new, rep = plan_chunk(src)
    for r in rep:
        print(r)

    print("[gate]  %s  %.0f KB" % (os.path.basename(GATE), os.path.getsize(GATE) / 1024.0))
    gsrc = read(GATE)
    gnew, grep = plan_gate(gsrc)
    for r in grep:
        print("  " + r)

    if a.check:
        print("[check] 未写入")
        return

    if new != src:
        if not os.path.exists(CHUNK + BAK):
            write(CHUNK + BAK, src)
        write(CHUNK, new)
        print("[write] chunk  %.0f KB" % (os.path.getsize(CHUNK) / 1024.0))
    else:
        print("[skip]  chunk 无变化")

    if gnew != gsrc:
        if not os.path.exists(GATE + BAK):
            write(GATE + BAK, gsrc)
        write(GATE, gnew)
        print("[write] gate   %.0f KB" % (os.path.getsize(GATE) / 1024.0))
    else:
        print("[skip]  gate 无变化")


if __name__ == "__main__":
    main()
