// 语音转文字。
//
// 两条路，默认走离线：
//   1. `local`  —— 原生 `EllenLocalSpeech`（sherpa-onnx + streaming zipformer 中文 14M int8，
//      24 MB 打进 APK）。不联网、不要 key、音频不出手机。这台 vivo 没有系统
//      `RecognitionService`（键盘上的语音键是输入法私有链路，没有对外 API），所以自己带。
//   2. `siliconflow` / `custom` —— OpenAI 兼容的 `/v1/audio/transcriptions`（硅基流动
//      SenseVoice 有免费额度）。离线识别返回空、或者模型没加载好时自动退到这条。
//
// 云端 key 走 EllenSecureConfig（与聊天模型同一套系统密钥库），明文不落 localStorage。
import { call } from './native/bridge.js';

const SCOPE = 'asr';

export const PLATFORMS = [
  {
    id: 'local',
    label: '离线识别',
    endpoint: '',
    model: 'streaming-zipformer-zh-14m-int8',
    keyHint: '模型装在手机里，不用 key、不联网、录音不出手机。准确率略低于云端，日常说话够用。',
  },
  {
    id: 'siliconflow',
    label: '硅基流动',
    endpoint: 'https://api.siliconflow.cn/v1/audio/transcriptions',
    model: 'FunAudioLLM/SenseVoiceSmall',
    keyHint: '在硅基流动控制台「API 密钥」建一枚，形如 sk- 开头；这个模型有免费额度。',
  },
  {
    id: 'custom',
    label: '自定义',
    endpoint: '',
    model: '',
    keyHint: '填任意 OpenAI 兼容的 /v1/audio/transcriptions 地址，必须 https。',
  },
];

const LOCAL = PLATFORMS[0];
const CLOUD_DEFAULT = PLATFORMS[1];

const DEFAULT_CONFIG = {
  platform: 'local',
  endpoint: '',
  model: LOCAL.model,
  apiKey: '',
  language: 'zh',
  // 转写完就直接把这句话发出去（按住说话时最顺手）
  autoSend: false,
};

export function platformOf(id) {
  return PLATFORMS.find((p) => p.id === id) || PLATFORMS[0];
}

export async function loadConfig() {
  try {
    const res = await call('EllenSecureConfig', 'read', { scope: SCOPE });
    const raw = res && typeof res.value === 'string' ? res.value : '';
    if (!raw) return { ...DEFAULT_CONFIG };
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch (err) {
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveConfig(cfg) {
  const merged = { ...DEFAULT_CONFIG, ...cfg };
  await call('EllenSecureConfig', 'write', { scope: SCOPE, value: JSON.stringify(merged) });
  return merged;
}

export async function clearConfig() {
  await call('EllenSecureConfig', 'remove', { scope: SCOPE });
}

export function isUsable(cfg) {
  if (!cfg) return false;
  if (cfg.platform === 'local') return true; // 模型在包里，不需要 key
  return !!(cfg.apiKey && cfg.endpoint && cfg.model);
}

/** 离线引擎当前状态（原生 EllensLocalSpeech 报的）：{available, loading, model, lastError} */
export async function localState() {
  try {
    return await call('EllenLocalSpeech', 'state', {});
  } catch (err) {
    return { available: false, loading: false, lastError: (err && err.message) || 'offline-engine-missing' };
  }
}

/** 用包里那套离线模型转写一段 WAV（base64）。 */
export async function transcribeLocal({ base64 }) {
  const res = await call('EllenLocalSpeech', 'transcribe', { base64 });
  const text = String((res && res.text) || '').trim();
  if (!text) {
    throw Object.assign(new Error('没听清，再说一遍？'), { code: 'ASR_EMPTY_RESULT' });
  }
  return { text, ms: (res && res.ms) || 0, raw: res };
}

function base64ToBlob(base64, type = 'audio/wav') {
  const bin = atob(base64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

/**
 * 转写一段录音。
 * @param {{fileId: string, base64: string, config?: object}} input
 * @returns {Promise<{text: string, raw: any}>}
 */
export async function transcribe({ fileId, base64, config }) {
  const cfg = config || (await loadConfig());
  if (!base64) {
    throw Object.assign(new Error('这段录音是空的。'), { code: 'ASR_EMPTY_AUDIO' });
  }
  if (cfg && cfg.platform === 'local') {
    try {
      return await transcribeLocal({ base64 });
    } catch (err) {
      // 离线没识别出来（模型坏了/静音/杂音）—— 有云端 key 就再试一次，没有就把原错误抛上去
      const cloud = await loadConfig().catch(() => null);
      if (!cloud || !cloud.apiKey || !cloud.endpoint) throw err;
      const retry = { ...cloud, platform: cloud.platform === 'local' ? 'siliconflow' : cloud.platform };
      return transcribeCloud({ fileId, base64, cfg: retry });
    }
  }
  if (!isUsable(cfg)) {
    throw Object.assign(new Error('语音转文字还没配服务。'), { code: 'ASR_NOT_CONFIGURED' });
  }
  return transcribeCloud({ fileId, base64, cfg });
}

async function transcribeCloud({ fileId, base64, cfg }) {

  const form = new FormData();
  form.append('file', base64ToBlob(base64), `${fileId || 'recording'}.wav`);
  form.append('model', cfg.model);
  if (cfg.language) form.append('language', cfg.language);
  form.append('response_format', 'json');

  let res;
  try {
    res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      body: form,
    });
  } catch (err) {
    throw Object.assign(new Error('连不上语音服务，检查一下网络。'), { code: 'ASR_NETWORK' });
  }

  const body = await res.text();
  if (!res.ok) {
    const detail = body ? body.slice(0, 200) : '';
    throw Object.assign(new Error(`语音服务返回 ${res.status}${detail ? `：${detail}` : ''}`), {
      code: `ASR_HTTP_${res.status}`,
      status: res.status,
      detail,
    });
  }

  let text = '';
  try {
    const parsed = JSON.parse(body);
    text = (parsed && (parsed.text || parsed.result || parsed.transcript)) || '';
  } catch (err) {
    // 有的实现直接回纯文本
    text = body || '';
  }
  text = String(text).trim();
  if (!text) {
    throw Object.assign(new Error('没听清，再说一遍？'), { code: 'ASR_EMPTY_RESULT' });
  }
  return { text, raw: body };
}
