// 启动自检弹窗：查到新版就问一句「现在更不更」。
//
// 2026-11-20 老大要的：「进入程序之后自动核对本机和更新站，如果落后版本，弹窗询问是否更新」。
// M4: 改由 核心\ 实现
//
// 判定逻辑全在 core/update-prompt.js（纯函数，可单测）；这里只管 DOM 与下载/安装的点击流。
// 文案一律走 s('settings.updatePrompt*')，视图层不写中文字面量。
//
// ⚠️ 别把 native 的 check() 当成「同步返回检查结果」：
//   EllenUpdatesPlugin.check() 立刻 resolve `{started:true}`，真正的联网在 worker 线程，
//   结论通过 updateState 事件回来（phase = available / current / error / unpublished …）。
//   所以这里订阅一次事件，等第一个「定下来的」相位，再去判要不要弹窗。
import { s } from '../strings.zh.js';
import {
  available,
  ensureConfigured,
  manifestUrl,
  check as checkUpdate,
  state as readState,
  download as downloadUpdate,
  install as installUpdate,
  cancel as cancelUpdate,
  onUpdate,
  progressText,
} from '../core/updates.js';
import {
  AUTO_CHECK_DELAY,
  shouldPrompt,
  snooze,
  skipVersion,
  recordChecked,
} from '../core/update-prompt.js';
import { shouldOnboard } from '../core/onboarding.js';

// 等 native 报结论的上限。超过就当没查到，静默（设置页里手动查才报错）。
const EVENT_TIMEOUT = 20000;
// 「定下来了」的相位：再等下去也不会变
const SETTLED = ['available', 'current', 'unpublished', 'ready', 'error', 'cancelled'];

let card = null;
let busy = false;
let lastState = null;
let liveOff = null;
let livePromise = null;
const painters = new Set(); // 卡片打开时挂上去的 paint()
const waiters = new Set(); // 等某个相位的 Promise resolve 函数

/** 只订一次；页面里所有更新相关的界面共用这一条事件流 */
async function ensureLive() {
  if (livePromise) return livePromise;
  livePromise = (async () => {
    try {
      liveOff = await onUpdate((ev) => {
        if (!ev) return;
        lastState = { ...(lastState || {}), ...ev };
        painters.forEach((fn) => {
          try {
            fn(ev);
          } catch (_) {}
        });
        const phase = ev.phase;
        if (phase && phase !== 'checking') {
          waiters.forEach((w) => w(ev));
        }
      });
    } catch (_) {
      liveOff = () => {};
    }
    return liveOff;
  })();
  return livePromise;
}

/** 等 native 报一个「定下来」的相位；超时返回 null */
async function waitForSettled(timeout = EVENT_TIMEOUT) {
  await ensureLive();
  return new Promise((resolve) => {
    let timer = null;
    const fn = (ev) => {
      if (!SETTLED.includes(ev.phase)) return;
      finish(ev);
    };
    const finish = (ev) => {
      if (timer) clearTimeout(timer);
      waiters.delete(fn);
      resolve(ev || null);
    };
    timer = setTimeout(() => finish(null), timeout);
    waiters.add(fn);
  });
}

function node(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function host() {
  return document.querySelector('.ellen-app') || document.body;
}

function versionText(st) {
  const v = (st && st.current && st.current.version) || '';
  const c = st && st.current && st.current.versionCode;
  if (!v) return '';
  return c ? `${v}（${c}）` : v;
}

function latestText(st) {
  const v = (st && st.latest && st.latest.version) || '';
  const c = st && st.latest && st.latest.versionCode;
  if (!v) return '';
  return c ? `${v}（${c}）` : v;
}

/** 把当前 state 画到卡片上；下载中顺带推进度条 */
function paint(next) {
  if (!card) return;
  // native 的事件是「部分状态」（进度相位里没有 latest 之外的细节），直接替换会把
  // latest / current 冲掉 —— 标题退化成没有版本号，装完也说不清装的是哪个。合并着用。
  const st = { ...(lastState || {}), ...(next || {}) };
  lastState = st;
  const phase = (st && st.phase) || 'idle';

  const title = card.querySelector('.el-update-title');
  const cur = card.querySelector('.el-update-cur');
  const fresh = card.querySelector('.el-update-latest');
  const notes = card.querySelector('.el-update-notes');
  const bar = card.querySelector('.el-update-bar');
  const stat = card.querySelector('.el-update-status');
  const primary = card.querySelector('.el-update-btn.is-primary');
  const later = card.querySelector('.el-update-btn.is-ghost');
  const skip = card.querySelector('.el-update-skip');

  if (title) title.textContent = s('settings.updatePromptTitle');
  if (cur) cur.textContent = `${s('settings.updateCurrent')}${versionText(st)}`;
  if (fresh) {
    const latest = latestText(st);
    // 版本号一样但包换了（同版本重发）要说清楚，否则「新版 0.5.15 / 当前 0.5.15」看着像 bug
    const sameCode =
      st.latest && st.current && Number(st.latest.versionCode) === Number(st.current.versionCode) && st.latest.version;
    fresh.textContent = latest
      ? `${s('settings.updateLatest')}${latest}${sameCode ? ` · ${s('settings.updatePromptRepublished')}` : ''}`
      : '';
    fresh.hidden = !fresh.textContent;
  }

  const noteText = (st.latest && st.latest.notes) || '';
  if (notes) {
    notes.textContent = noteText || s('settings.updatePromptNotes');
    notes.hidden = !notes.textContent;
  }

  // 进度条只在下载/校验时有意义
  const total = Number(st.total || 0);
  const got = Number(st.received || 0);
  const showBar = phase === 'downloading' || phase === 'verifying';
  if (bar) {
    bar.parentElement.hidden = !showBar;
    if (showBar) {
      const pct = total ? Math.max(2, Math.min(100, Math.round((got / total) * 100))) : 30;
      bar.style.width = `${pct}%`;
    }
  }

  if (stat) {
    // available 时标题已经说了「有新版本 X」，底下再写一遍「有新版本」是废话
    let t = phase === 'available' ? '' : s(`settings.updatePhase_${phase}`);
    if (phase === 'downloading') {
      const p = progressText(st);
      if (p) t = `${s('settings.updateDownloading')}${p}`;
    }
    if (phase === 'ready') t = st.message || s('settings.updatePromptReady');
    if (phase === 'permission' || phase === 'installing') t = s('settings.updatePromptInstallHint');
    if (phase === 'error') t = `${s('settings.updateFail')}${st.lastError || st.message || ''}`;
    stat.textContent = t || '';
    stat.hidden = !t;
  }

  if (primary) {
    if (phase === 'available') {
      primary.textContent = s('settings.updatePromptNow');
      primary.disabled = busy;
      primary.dataset.act = 'download';
    } else if (phase === 'downloading' || phase === 'verifying') {
      primary.textContent = s('settings.updateCancel');
      primary.disabled = false;
      primary.dataset.act = 'cancel';
    } else if (phase === 'ready') {
      // 别拿 canInstall 决定按钮：它只是「未知来源」开关的瞬时值，
      // 关着的时候点「去安装」native 会自己跳设置页（publish permission），那才是该走的路。
      primary.textContent = s('settings.updateInstall');
      primary.disabled = busy;
      primary.dataset.act = 'install';
    } else if (phase === 'permission' || phase === 'installing') {
      primary.textContent = s('settings.updatePromptClose');
      primary.disabled = false;
      primary.dataset.act = 'close';
    } else {
      primary.textContent = s('settings.updatePromptNow');
      primary.disabled = true;
      primary.dataset.act = 'download';
    }
  }

  // 开下载之后就别再给「以后再说」了，容易误触留下半截包
  if (later) later.hidden = phase !== 'available';
  if (skip) skip.hidden = phase !== 'available';
}

export function closePrompt() {
  painters.delete(paint);
  if (card && card.parentElement) card.parentElement.remove();
  card = null;
  busy = false;
}

async function act(kind) {
  if (busy) return;
  busy = true;
  if (card) {
    const primary = card.querySelector('.el-update-btn.is-primary');
    if (primary) primary.disabled = true;
  }
  try {
    if (kind === 'download' || kind === 'install') {
      // 两个都不返回完整状态，进度靠事件
      if (kind === 'download') await downloadUpdate();
      else await installUpdate();
    } else if (kind === 'cancel') {
      await cancelUpdate();
    } else if (kind === 'close') {
      closePrompt();
      return;
    }
  } catch (err) {
    paint({ phase: 'error', message: String((err && err.message) || err) });
  }
  busy = false;
  if (card) paint(lastState || {});
}

/** 打开弹窗；st 是 EllenUpdates 的事件/state 对象 */
export function openPrompt(st) {
  if (card) {
    lastState = { ...(lastState || {}), ...(st || {}) };
    paint(st);
    return card;
  }
  lastState = { ...(st || {}) };

  const mask = node('div', 'el-update-mask');
  mask.setAttribute('role', 'dialog');
  mask.setAttribute('aria-modal', 'true');

  card = node('div', 'el-update-card');
  card.append(
    node('div', 'el-update-title', s('settings.updatePromptTitle')),
    node('div', 'el-update-row', null),
  );
  // 版本两行放同一个竖排容器里，省得卡面上散成两段
  const row = card.querySelector('.el-update-row');
  row.append(node('div', 'el-update-cur', ''), node('div', 'el-update-latest', ''));
  card.append(node('div', 'el-update-notes', ''));

  const barWrap = node('div', 'el-update-barwrap');
  barWrap.append(node('div', 'el-update-bar'));
  barWrap.hidden = true;
  card.append(barWrap, node('div', 'el-update-status', ''));

  const actions = node('div', 'el-update-actions');
  const primary = node('button', 'el-update-btn is-primary', s('settings.updatePromptNow'));
  primary.type = 'button';
  primary.dataset.act = 'download';
  const later = node('button', 'el-update-btn is-ghost', s('settings.updatePromptLater'));
  later.type = 'button';
  actions.append(primary, later);
  card.append(actions);

  const skip = node('button', 'el-update-skip', s('settings.updatePromptSkip'));
  skip.type = 'button';
  card.append(skip);

  mask.append(card);
  host().append(mask);

  painters.add(paint);
  ensureLive();

  primary.addEventListener('click', () => {
    const kind = primary.dataset.act || 'download';
    if (kind === 'close') closePrompt();
    else act(kind);
  });

  later.addEventListener('click', () => {
    snooze();
    closePrompt();
  });

  skip.addEventListener('click', () => {
    const code = Number((lastState && lastState.latest && lastState.latest.versionCode) || 0);
    skipVersion(code);
    closePrompt();
  });

  paint(st);
  return card;
}

/** 首次打开还在走引导：别把更新框糊在引导页上，等他把引导走完（或跳过）再说 */
async function waitUntilPastWelcome(maxMs = 10 * 60 * 1000) {
  if (!shouldOnboard()) return true;
  const t0 = Date.now();
  while (shouldOnboard() && Date.now() - t0 < maxMs) {
    await new Promise((r) => setTimeout(r, 1500));
  }
  return !shouldOnboard();
}

/**
 * 顺手清掉「已经装进系统」的安装包（native 私有目录 files/updates/update.apk，约 100 MB）。
 *
 * native 那边 pruneInstalledApk() 只在 state() 和 install 收尾时被调；启动自检走的是
 * check()，所以以前这条清理从来不跑，装完新版本包就一直躺在手机上。
 * 这里单独叫一次 state()，纯粹为了让它清理 —— 返回的相位一律丢掉，绝不参与判定。
 */
async function cleanupOldPackage() {
  try {
    await readState();
  } catch (_) {
    // 清理失败不影响更新检查
  }
}

/**
 * 启动自检入口。main.js 在首屏起来之后调用，别 await 在 show() 前面。
 * 返回弹窗卡片（没弹返回 null），便于测试断言。
 */
export async function autoCheckOnLaunch({ delay = AUTO_CHECK_DELAY } = {}) {
  // 先请 native 扫一眼私有目录里的安装包：装成功的那个包会在这里被删掉
  // （EllenUpdatesPlugin.state() 里调 pruneInstalledApk，判据是「包里的 versionCode
  //   ≤ 已装版本」= 已经生效了，留着就是一百多兆垃圾）。
  // 这一步跟「要不要查更新」无关，所以放在所有开关判断之前：关掉更新检查也照样清。
  // 2026-11-20 老大问「每次更新会留着旧版安装包吗」—— 会，实测装完 0.5.16 后
  // files/updates/update.apk 还留着 109 MB；原因是启动只走 check() 不走 state()，
  // prune 从来没被触发过。这里补上。
  await cleanupOldPackage();

  if (!(await available())) return null;
  // 用户把地址清空 = 主动关掉更新检查，那就别联网
  if (!manifestUrl()) return null;
  if (delay > 0) await new Promise((r) => setTimeout(r, delay));

  // 引导页不弹（那上面本来就有一串要读的东西，糊个框上去只会让人烦）
  if (!(await waitUntilPastWelcome())) return null;

  await ensureConfigured().catch(() => {});
  await ensureLive();

  // 一律走 check()，别信持久化的 phase：
  //   磁盘上记着 ready，但包可能已经被 native 清掉了（装完 / 版本判定过期），
  //   照它弹窗就会出现「下载好了」→ 点安装 → 报「还没有下载好的安装包」。
  //   check() 内部有 stagedPackageReady()，它会准确区分 available 和 ready。

  // check 只回 {started:true}，结论等事件
  const wait = waitForSettled();
  try {
    await checkUpdate();
  } catch (err) {
    // UPDATE_BUSY：别的地方正在更新，等事件就行，不算失败
    const msg = String((err && err.message) || err);
    if (!/正在更新/.test(msg)) {
      recordChecked({ phase: 'error', message: msg });
      return null;
    }
  }
  const ev = await wait;
  if (!ev)
    return null; // 超时 / 没网：静默，别拿这个烦用户

  const st = { ...(lastState || {}), ...ev };
  lastState = st;
  recordChecked(st);
  if (!shouldPrompt(st)) return null;
  openPrompt(st);
  return card;
}
