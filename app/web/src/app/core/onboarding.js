// 首次打开引导（welcome 页）的状态与步骤表。纯逻辑，不碰 DOM、不碰原生 —— node 能直接跑。
//
// 为什么状态放 localStorage 而不是 store/records 的 meta 表：
//   1) 首屏要「同步」判断该不该进引导。IDB 只有 async API，等它读完再决定，
//      会先闪一下聊天页再跳走 —— 第一次打开的人看到的是「聊天页一闪、然后被拽去别处」。
//   2) 这份状态不该跟着聊天记录一起备份/合并。换机重装本来就该重新认识一遍，
//      把旧机的 done 搬过来反而会让人卡在聊天页、再也看不到引导。
//   所以沿用 persona / lore / backup 那套 `ellen.*.v1` 的 localStorage 键。
//
// 文案不在这里：所有句子在 ui/views/welcome/welcome.js 的 TXT 表里（Lead 最后统一收进 strings）。
const KEY = 'ellen.onboarded.v1';

/** 步骤 id。顺序由 buildSteps 决定，这里只给稳定的名字。 */
export const STEP_WHO = 'who'; // 她是谁
export const STEP_TALK = 'talk'; // 怎么说话（语音/文字 + 麦克风）
export const STEP_MEMORY = 'memory'; // 她记得你（记忆在本机 + 备份入口）
export const STEP_LEGACY = 'legacy'; // 从旧版搬过来（没有旧数据时整步不出现）
export const STEP_PING = 'ping'; // 愿不愿意让她主动找你
export const STEP_DONE = 'done'; // 完成

/** 没存过 / 存坏了都回落到这份。 */
export const DEFAULT_ONBOARDED = { done: false, at: 0, step: 0, stepId: '', skipped: false };

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function readRaw() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    // 隐私模式 / 写坏：当成「还没引导过」比当成「引导过」安全 ——
    // 多走一遍引导只是烦一下，少走一遍是新人第一次打开就面对一屏聊天记录。
    return null;
  }
}

/** 读状态：形状永远完整，调用方不用到处写 `|| {}`。 */
export function readOnboarded() {
  const src = readRaw();
  if (!src) return { ...DEFAULT_ONBOARDED };
  return {
    done: src.done === true,
    at: Number(src.at) || 0,
    step: clampInt(src.step, 0, 32, 0),
    // stepId 不在契约里，是给「上次停在第 4 步，但这次没有旧数据、那一步没了」兜底的：
    // 只靠数字会在步骤表变化时指错一格，存个 id 就能按名字找回来。
    stepId: typeof src.stepId === 'string' ? src.stepId : '',
    skipped: src.skipped === true,
  };
}

function writeOnboarded(patch) {
  const next = { ...readOnboarded(), ...(patch && typeof patch === 'object' ? patch : {}) };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch (err) {
    // 存不下就本次会话内继续（引导仍能走完），下次打开会再引导一遍 —— 可接受
    console.warn('[onboarding] 存不下', err);
  }
  return next;
}

/** 该不该进引导。同步，首屏可直接用。 */
export function shouldOnboard() {
  return !readOnboarded().done;
}

/**
 * 记下「现在停在第几步」。每往前一步调一次 ——
 * 用户中途杀掉 App，下次从这里接着走，不是从头再问一遍。
 */
export function markStep(index, stepId = '') {
  return writeOnboarded({ step: clampInt(index, 0, 32, 0), stepId: typeof stepId === 'string' ? stepId : '' });
}

/** 走完（或跳过）。skipped:true 表示是点「跳过」走的，将来要统计/回访只找 false 那批。 */
export function markDone({ skipped = false, step, stepId, at = Date.now() } = {}) {
  const cur = readOnboarded();
  return writeOnboarded({
    done: true,
    at: Number(at) || Date.now(),
    step: step === undefined ? cur.step : clampInt(step, 0, 32, cur.step),
    stepId: typeof stepId === 'string' ? stepId : cur.stepId,
    skipped: skipped === true,
  });
}

/** 清掉状态（调试用，也给「重新走一遍引导」留个口）。 */
export function reset() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* 清不掉就当没清 */
  }
  return { ...DEFAULT_ONBOARDED };
}

/**
 * 步骤表。基础 5 步；只有真的扫到旧资料包时才插入「搬过来」那一步 ——
 * 没旧数据的人不该看到一屏「没找到，下一步」，那一步必须**不存在**，
 * 而不是存在但空着（那样步骤号、进度点也都会跟着错）。
 */
export function buildSteps({ legacyCount = 0 } = {}) {
  const ids = [STEP_WHO, STEP_TALK, STEP_MEMORY];
  if (Number(legacyCount) > 0) ids.push(STEP_LEGACY);
  ids.push(STEP_PING, STEP_DONE);
  return ids.map((id, index) => ({ id, index }));
}

/**
 * 断点续：从哪一步接着走。
 * 先按 stepId 找（步骤表变了也能对上），找不到再按数字夹回合法范围。
 */
export function resumeIndex(steps, saved = readOnboarded()) {
  const list = Array.isArray(steps) ? steps : [];
  if (!list.length) return 0;
  const sid = saved && typeof saved.stepId === 'string' ? saved.stepId : '';
  if (sid) {
    const hit = list.findIndex((s) => s && s.id === sid);
    if (hit >= 0) return hit;
  }
  return clampInt(saved && saved.step, 0, list.length - 1, 0);
}

/** 给界面用的进度摘要（第几步 / 共几步）。 */
export function progressOf(steps, index) {
  const count = Array.isArray(steps) ? steps.length : 0;
  const at = clampInt(index, 0, Math.max(0, count - 1), 0);
  return { index: at, count, human: at + 1 };
}
