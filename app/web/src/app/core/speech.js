// 朗读（她说话）。
//
// 只用 minimax 云端音色（`EllenSpeech.synthesize` → mp3 → Audio 播放）。
// 系统 TTS 那条路已经不在界面上出现（用户 2026-11-11 要求删掉：模拟器没有引擎、
// 真机音色也不像她）。代码里保留 `speak()` 的原生分支只作为云端彻底失败时的兜底。
//
// 为什么云端音色走「原生拿字节、web 播放」而不是原生播放：
// WebView 的 <audio> 播 mp3 是系统能力，省掉一套 MediaPlayer 状态机（旧包为此写了
// `EllenAudio` 的 play/pause/setVolume/setLoop 五个方法 + 一个通话 PCM 通道）。
//
// 偏好存 localStorage（不是密钥）：{ auto, clip, rate, provider, model, voiceId }
//   auto —— 文字加语音朗读（她说完了就念）
//   clip —— 随机语音条（偶尔只给一条语音条，点开才听）
// minimax 的 key 走 EllenSecureConfig（scope `tts`），明文不落 localStorage。
import { call, listen } from './native/bridge.js';

const PREFS_KEY = 'ellen.voice.v1';
const TTS_SCOPE = 'tts';
const DEFAULTS = {
  auto: false,
  clip: false,
  rate: 1.0,
  voice: '',
  provider: 'minimax',
  model: 'speech-2.8-hd',
  voiceId: 'female-shaonv',
  endpoint: 'https://api.minimax.cn/v1/t2a_v2',
};

let cached = null;
let audioEl = null;
let playingUrl = '';

export function readPrefs() {
  if (cached) return { ...cached };
  let raw = null;
  try {
    raw = localStorage.getItem(PREFS_KEY);
  } catch (_) {
    raw = null;
  }
  if (!raw) {
    cached = { ...DEFAULTS };
    return { ...cached };
  }
  try {
    const parsed = JSON.parse(raw);
    cached = {
      ...DEFAULTS,
      ...parsed,
      auto: !!parsed.auto,
      rate: typeof parsed.rate === 'number' ? Math.min(2, Math.max(0.5, parsed.rate)) : DEFAULTS.rate,
      provider: parsed.provider === 'minimax' ? 'minimax' : 'system',
    };
  } catch (_) {
    cached = { ...DEFAULTS };
  }
  return { ...cached };
}

export function writePrefs(patch) {
  const next = { ...readPrefs(), ...patch };
  if (typeof next.rate === 'number') next.rate = Math.min(2, Math.max(0.5, next.rate));
  if (next.provider !== 'minimax') next.provider = 'system';
  cached = next;
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(next));
  } catch (_) {
    // 存不了就只在本进程生效，不影响朗读
  }
  return { ...next };
}

/** minimax 的 key：进系统密钥库，与聊天模型的 key 同等待遇。 */
export async function readKey() {
  try {
    const res = await call('EllenSecureConfig', 'read', { scope: TTS_SCOPE });
    const raw = (res && typeof res.value === 'string' && res.value) || '';
    if (!raw) return '';
    // 兼容被写成 JSON（{"apiKey":"sk-…"}）的历史值：直接拿去当 Authorization 会 401，
    // 而界面只会说「key 不对」，很难查。这里统一摊平成裸 key。
    if (raw.trim().startsWith('{')) {
      try {
        const obj = JSON.parse(raw);
        return (obj && typeof obj.apiKey === 'string' && obj.apiKey.trim()) || '';
      } catch (_) {
        return '';
      }
    }
    return raw.trim();
  } catch (_) {
    return '';
  }
}

export async function writeKey(key) {
  if (!key) return '';
  await call('EllenSecureConfig', 'write', { scope: TTS_SCOPE, value: key });
  return key;
}

export async function clearKey() {
  try {
    await call('EllenSecureConfig', 'remove', { scope: TTS_SCOPE });
  } catch (_) {
    // 清不掉就当没有
  }
}

export async function state() {
  try {
    return await call('EllenSpeech', 'state', {});
  } catch (err) {
    return { available: false, speaking: false, lastError: String((err && err.message) || err), voices: [] };
  }
}

function stopAudio() {
  if (audioEl) {
    try {
      audioEl.pause();
    } catch (_) {
      // 已经停了
    }
    audioEl = null;
  }
  if (playingUrl) {
    try {
      URL.revokeObjectURL(playingUrl);
    } catch (_) {
      // ignore
    }
    playingUrl = '';
  }
}

function base64ToBlobUrl(base64, mime) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

async function speakCloud(body, prefs) {
  const key = await readKey();
  if (!key) {
    return { speaking: false, error: '还没填朗读服务的 key', code: 'NO_API_KEY' };
  }
  const res = await call('EllenSpeech', 'synthesize', {
    text: body,
    apiKey: key,
    endpoint: prefs.endpoint || DEFAULTS.endpoint,
    model: prefs.model || DEFAULTS.model,
    voiceId: prefs.voiceId || DEFAULTS.voiceId,
    speed: typeof prefs.rate === 'number' ? prefs.rate : 1.0,
  });
  if (!res || !res.base64) {
    return { speaking: false, error: '朗读服务没给音频', code: 'TTS_EMPTY' };
  }
  stopAudio();
  const mime = res.format === 'mp3' ? 'audio/mpeg' : `audio/${res.format || 'mpeg'}`;
  playingUrl = base64ToBlobUrl(res.base64, mime);
  audioEl = new Audio(playingUrl);
  audioEl.onended = () => stopAudio();
  await audioEl.play();
  return { speaking: true, provider: 'minimax', bytes: res.bytes || 0 };
}

export async function speak(text, opts = {}) {
  const body = String(text || '').trim();
  if (!body) return { speaking: false, skipped: true };
  const prefs = readPrefs();
  const provider = opts.provider || prefs.provider || 'system';

  if (provider === 'minimax') {
    try {
      const ok = await speakCloud(body, prefs);
      if (ok && ok.speaking) return ok;
      // 云端不通就退回系统 TTS，别让「她会说话」断在一个 key 上
      if (ok && ok.error) {
        const fallback = await speakSystem(body, prefs, opts);
        return { ...fallback, fallbackFrom: ok.error, code: ok.code };
      }
      return ok;
    } catch (err) {
      const fallback = await speakSystem(body, prefs, opts);
      return { ...fallback, fallbackFrom: String((err && err.message) || err) };
    }
  }
  return speakSystem(body, prefs, opts);
}

async function speakSystem(body, prefs, opts) {
  try {
    return await call('EllenSpeech', 'speak', {
      text: body,
      rate: typeof opts.rate === 'number' ? opts.rate : prefs.rate,
      voice: opts.voice || prefs.voice,
      pitch: typeof opts.pitch === 'number' ? opts.pitch : 1.0,
    });
  } catch (err) {
    return { speaking: false, error: String((err && err.message) || err) };
  }
}

export async function stop() {
  stopAudio();
  try {
    return await call('EllenSpeech', 'stop', {});
  } catch (_) {
    return { speaking: false };
  }
}

/** 听原生事件（start / done / error）。返回取消订阅的 Promise<function>。 */
export async function onSpeech(cb) {
  if (typeof cb !== 'function') return () => {};
  return listen('EllenSpeech', 'speechEvent', cb);
}

/** 只念纯文本：把 Markdown 的强调符号与代码围栏剥掉，别让引擎念出星号。 */
/** 随机语音条：把一句话念成一条「语音条」挂在气泡里。
 *  为什么按概率而不是全量：每条都合成既费钱又吵，偶尔一条才有「她随手发了条语音」的感觉。
 *  概率固定 1/7，不做开关档位 —— 用户要的就是「开/关」两态。 */
const CLIP_ODDS = 7;

export function maybeClip() {
  const prefs = readPrefs();
  if (!prefs.clip) return false;
  return Math.floor(Math.random() * CLIP_ODDS) === 0;
}

/** 合成一段可直接给 <audio> 用的 blob url（调用方负责在不用时 revoke）。 */
export async function synthesizeUrl(text, opts = {}) {
  const clean = plain(text).slice(0, 220);
  if (!clean) {
    const err = new Error('没有要念的内容');
    err.code = 'SPEECH_EMPTY';
    throw err;
  }
  const prefs = readPrefs();
  const key = await readKey();
  if (!key) {
    const err = new Error('还没填 minimax 的 key');
    err.code = 'NO_API_KEY';
    throw err;
  }
  const res = await call('EllenSpeech', 'synthesize', {
    text: clean,
    apiKey: key,
    endpoint: prefs.endpoint,
    model: prefs.model,
    voiceId: prefs.voiceId || 'female-shaonv',
    speed: prefs.rate,
  });
  return { url: base64ToBlobUrl(res.base64, res.format || 'mp3'), bytes: res.bytes, ms: res.ms };
}

export function plain(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^[>\-\s]*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}
