// 启动自检：进程序之后自动核对本机与更新站，落后就问一句要不要更新。
//
// 2026-11-20 老大要的：「进入程序之后自动核对本机和更新站，如果落后版本，弹窗询问是否更新」。
// M4: 改由 核心\ 实现
//
// 分工别搞混：
//   native 的 EllenUpdates.check() 已经把该比的都比过了 —— versionCode、ABI 有没有包、
//   同版本重发（版本号一样但 sha 不同）也算有更新，结论落在 phase 上（'available' / 'current' …）。
//   所以这里**不再自己比 versionCode**，只判两件事：
//     1. 现在这状态要不要打扰用户（phase === 'available' 才打扰）；
//     2. 用户上次说了什么（以后再说 / 这个版本不再提醒）。
//   自己再比一遍 versionCode 会把「同版本重发包」永远推不下去，那是 native 早就修过的坑。

const KEY = 'ellen.updatePrompt.v1';

// 启动后先让首屏渲染、档案馆读库跑完，再联网查。抢在首屏前面会把冷启动拖慢。
export const AUTO_CHECK_DELAY = 4000;

// 「以后再说」= 24 小时内不再问；过了还会再问一次（版本还落后的话）。
export const SNOOZE_MS = 24 * 60 * 60 * 1000;

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function write(patch) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...read(), ...patch }));
  } catch (_) {
    // 存不下不影响功能：下次启动会再问一遍而已
  }
}

/** native 判定的「有新版」——包换过、版本号更高，都能落到 available 上 */
export function hasUpdate(st) {
  if (!st || !st.latest || !(st.latest.version || st.latest.versionCode)) return false;
  if (st.phase === 'available') return true;
  // 上次下载好了但没点安装（中途退出）：包还在，也该问一句要不要现在去装
  if (st.phase === 'ready' && st.canInstall !== false) return true;
  return false;
}

/**
 * 要不要弹窗问。
 * @param {object} st  EllenUpdates.state()/check() 的返回
 * @param {number} now 便于测试注入
 */
export function shouldPrompt(st, now = Date.now()) {
  if (!hasUpdate(st)) return false;
  const rec = read();
  const code = Number(st.latest.versionCode || 0);
  if (rec.skipped && Number(rec.skipped.versionCode) === code) return false;
  if (rec.snoozeUntil && Number(rec.snoozeUntil) > now) return false;
  return true;
}

/** 点了「以后再说」 */
export function snooze(now = Date.now()) {
  write({ snoozeUntil: now + SNOOZE_MS });
}

/** 点了「这个版本不再提醒」——只对这个 versionCode 生效，出了新的还会问 */
export function skipVersion(versionCode) {
  write({
    skipped: { versionCode: Number(versionCode) || 0, at: Date.now() },
    snoozeUntil: 0,
  });
}

/** 手动清掉这两条记忆（设置页「检查更新」点到新版时用得上） */
export function forgetPrompt() {
  write({ snoozeUntil: 0, skipped: null });
}

/** 记一笔上次检查（只用于排查，不参与判定） */
export function recordChecked(st) {
  write({ lastCheckAt: Date.now(), lastPhase: (st && st.phase) || '' });
}

export function promptState() {
  return read();
}
