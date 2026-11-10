// 聊天偏好：一条消息发出去之后，请求怎么拼。
//
// 跟 model config 分开：那边是「连哪家、用哪枚 key」，这边是「这次请求带多少上下文」。
// 换平台不该把这些设置一起重置，所以另存一个键。
const KEY = 'ellen.chat.v1';

export const HISTORY_OPTIONS = [10, 20, 30, 50];

export const DEFAULT_PREFS = {
  // 记忆召回：关掉之后 system 段里不再出现「她记得的事」
  recall: true,
  // 带几条记忆进 prompt。老 bug ③ 是「永远同样 7 条」，新壳按条数给死上限 + 打分排序
  recallLimit: 6,
  // 带多少条历史消息。越多越贵，也越容易跑偏
  history: 20,
  // 思考模式：default 跟随模型；disabled 关掉（省时间省钱）
  thinking: 'default',
};

export function readChatPrefs() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw);
    const merged = { ...DEFAULT_PREFS, ...parsed };
    merged.recallLimit = clampInt(merged.recallLimit, 1, 12, DEFAULT_PREFS.recallLimit);
    merged.history = clampInt(merged.history, 4, 60, DEFAULT_PREFS.history);
    if (merged.thinking !== 'disabled' && merged.thinking !== 'enabled') merged.thinking = 'default';
    merged.recall = !!merged.recall;
    return merged;
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function writeChatPrefs(patch) {
  const merged = { ...readChatPrefs(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(merged));
  } catch (err) {
    console.warn('[chatPrefs] 存不下', err);
  }
  return merged;
}

export function resetChatPrefs() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* 清不掉就用默认值 */
  }
  return { ...DEFAULT_PREFS };
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}
