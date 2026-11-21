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

/**
 * 「这一条念完了吗」的等待器。
 *
 * 为什么需要有它：`speak()` 里的 `await audioEl.play()` 只等到**开始播**就返回了
 * （<audio> 的 play() 语义如此）。所以调用方想「一条一条接着念」时，拿不到
 * 「念完」这个时刻——照直觉写成 for 循环逐条 await，每条都会在下一条开始时被
 * `new Audio` 掐断，听起来跟「只念一条」一模一样。0.5.x 的朗读 bug 就是栽在这。
 */
let doneResolve = null;
let donePromise = null;

function beginDone() {
  // 上一轮要是还没结（比如被强停），先把它 resolve 掉，别让调用方永久挂住
  settleDone();
  donePromise = new Promise((resolve) => {
    doneResolve = resolve;
  });
  return donePromise;
}

function settleDone() {
  const resolve = doneResolve;
  doneResolve = null;
  donePromise = null;
  if (resolve) resolve();
}

/**
 * 等当前这条念完。`onended` / `onerror` / 被 `stop()` 三种情况都算完成。
 * 没有在念的时候立刻 resolve —— 调用方不用区分「本来就静音」和「刚念完」。
 *
 * 注意：只覆盖 <audio> 那条主路（minimax）。系统 TTS 兜底分支拿不到可靠的
 * 完成事件，调用方应当自己加超时，不要把等待完全押在这上面。
 */
export function whenDone() {
  return donePromise || Promise.resolve();
}

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
  // 主动停也算「这一条结束了」，否则连读的调用方会一直等下去
  settleDone();
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
  const done = beginDone();
  audioEl.onended = () => {
    stopAudio();
    settleDone();
  };
  // 解码失败 / 网络中断也要结，不然连读会卡在这一条上
  audioEl.onerror = () => {
    stopAudio();
    settleDone();
  };
  try {
    await audioEl.play();
  } catch (err) {
    stopAudio();
    settleDone();
    throw err;
  }
  return { speaking: true, provider: 'minimax', bytes: res.bytes || 0, done };
}

export async function speak(text, opts = {}) {
  // 这里再过一次 plain：chat 那条路自己剥过，通话播报（call.js）是把原始台词直接传进来的，
  // 不剥的话「（她顿了一下）」照样会被念出来。plain 是幂等的，多过一遍没有副作用。
  const body = plain(text);
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

/** 只念纯文本：剥 Markdown 符号，也剥「（动作）」——动作是写给眼睛看的，念出来就出戏。
 *
 *  0.5.3 以前的坑：动作开起来之后，`（她轻轻叹了口气）` 原样进了 TTS，整条朗读都是括号旁白。
 *  规则：括号内 1~60 字、不含换行、不嵌套才剥（超长/带换行的多半是正文补充说明，不动）；
 *  全角半角圆括号、方括号、星号动作各剥一遍；剥完一个字都不剩就退回原文，
 *  别把空串塞给合成接口（那边会报「这条台词暂时无法合成」，看起来比念括号更像坏了）。
 */
export function plain(text) {
  const flat = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^[>\-\s]*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return '';
  const bare = flat
    .replace(/[（(][^（()）\r\n]{1,60}[）)]/g, '')
    .replace(/[【\[][^【】\[\]\r\n]{1,60}[】\]]/g, '')
    .replace(/\*[^*\r\n]{1,60}\*/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return /[\p{L}\p{N}]/u.test(bare) ? bare : flat;
}
