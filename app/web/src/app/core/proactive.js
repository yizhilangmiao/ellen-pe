// 主动消息的 web 侧胶水。
//
// 分工：native 负责定时（AlarmManager）、后台执行（WorkManager + 直连 HTTP）、发通知。
// web 负责三件事：
//   1. 把「素材」推给 native —— 人设、记忆、最近聊天、节奏；不推就发不出像样的话。
//   2. 开关与节奏（configure）。
//   3. 点通知回来时把待读消息取走（consumeOpen），落成一条真正的聊天记录。
//
// 旧包在这里全靠后台 WebView 跑整条链，后台进程起不了 WebView 所以永远发不出；
// 现在 web 只做「配置与取回」，不参与后台执行。
import { call } from './native/bridge.js';
import { listLatest } from './store/library.js';

const DEFAULT_PERSONA =
  '你是艾莲，一个会主动惦记他的女孩。说话口语、短、不客套，像是在微信里随手发一条。';

const DEFAULT_RHYTHM = {
  minGapMs: 60 * 60 * 1000,
  maxGapMs: 3 * 60 * 60 * 1000,
  quietStart: 23,
  quietEnd: 8,
};

export const RHYTHMS = [
  { id: 'often', label: '常来找我', minGapMs: 30 * 60 * 1000, maxGapMs: 90 * 60 * 1000 },
  { id: 'normal', label: '自然一些', minGapMs: 60 * 60 * 1000, maxGapMs: 3 * 60 * 60 * 1000 },
  { id: 'rare', label: '别太频繁', minGapMs: 3 * 60 * 60 * 1000, maxGapMs: 8 * 60 * 60 * 1000 },
];

export function rhythmOf(id) {
  return RHYTHMS.find((r) => r.id === id) || RHYTHMS[1];
}

/** native 侧是否可用（模拟器/网页预览下没有这个插件）。 */
export async function available() {
  try {
    const st = await call('EllenAutonomy', 'state', {});
    return !!(st && st.available);
  } catch {
    return false;
  }
}

export async function readState() {
  try {
    return await call('EllenAutonomy', 'state', {});
  } catch {
    return { available: false, enabled: false, permission: 'unknown', hasPending: false };
  }
}

/**
 * 把当前素材推给 native。每次都整体覆盖（native 侧是合并式写入，
 * 字段缺省就保留旧值，所以这里必须把该有的都带上）。
 */
export async function pushMaterial({ config, messages, rhythmId } = {}) {
  const rhythm = { ...DEFAULT_RHYTHM, ...rhythmOf(rhythmId || 'normal') };
  let memories = [];
  try {
    const rows = await listLatest('memory', { limit: 12 });
    memories = rows
      .map((r) => ({
        title: String(r.value?.title || '').slice(0, 40),
        body: String(r.value?.summary || r.value?.body || '').slice(0, 300),
      }))
      .filter((m) => m.body);
  } catch (err) {
    console.warn('[proactive] 取记忆失败', err);
  }

  const recent = (messages || [])
    .filter((m) => m && m.text && !m.pending && !m.failed)
    .slice(-8)
    .map((m) => ({ role: m.role, text: String(m.text).slice(0, 300) }));

  return call('EllenAutonomy', 'setContext', {
    persona: DEFAULT_PERSONA,
    endpoint: config?.endpoint || '',
    model: config?.model || '',
    minGapMs: rhythm.minGapMs,
    maxGapMs: rhythm.maxGapMs,
    quietStart: rhythm.quietStart,
    quietEnd: rhythm.quietEnd,
    memories,
    recent,
  });
}

/** 开/关。开启时会先重排下一次（native 侧 scheduleNext）。 */
export async function setEnabled(enabled, { profileId } = {}) {
  return call('EllenAutonomy', 'configure', { enabled: !!enabled, profileId: profileId || '' });
}

/**
 * 取走待读的主动消息。返回 null 表示没有。
 * 取走即清空 —— native 侧是单槽，同一句不会被消费两次。
 */
export async function takePending() {
  try {
    const res = await call('EllenAutonomy', 'consumeOpen', {});
    if (res && res.type === 'proactive' && res.text) return res;
    return null;
  } catch {
    return null;
  }
}

/** 调试用：n 秒后跑一次。 */
export async function scheduleIn(delayMs) {
  return call('EllenAutonomy', 'scheduleIn', { delayMs });
}

export { DEFAULT_PERSONA, DEFAULT_RHYTHM };
