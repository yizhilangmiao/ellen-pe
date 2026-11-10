// 一键复刻艾莲音色（minimax voice_clone）。
//
// 为什么放在 web 层而不是原生插件：
//   实测 minimax 的 OPTIONS 预检带 `Access-Control-Allow-Headers: …,Authorization,…`，
//   WebView 直连可用，不必再写一套 Java 上传器。key 仍然从 EllenSecureConfig 取，
//   只在这次请求的内存里出现，不落 localStorage。
//
// 为什么要持久化「克隆任务」：
//   voice_clone 是按音色收费的（9.90 元/音色），重复点按钮不能重复扣钱。
//   任务一旦拿到 voice_id 就写进 localStorage，之后只复用、不再提交。
import { readKey, readPrefs, writePrefs } from './speech.js';

const REFERENCE = './voice-clone/ellen-reference.mp3';
const UPLOAD = 'https://api.minimax.cn/v1/files/upload';
const CLONE = 'https://api.minimax.cn/v1/voice_clone';
const JOB_KEY = 'ellen.voice.clone.v1';
const DEFAULT_MODEL = 'speech-2.8-hd';

function readJob() {
  try {
    const raw = localStorage.getItem(JOB_KEY);
    if (!raw) return null;
    const job = JSON.parse(raw);
    if (!job || typeof job.voiceId !== 'string' || !job.voiceId) return null;
    return job;
  } catch (_) {
    return null;
  }
}

function writeJob(job) {
  try {
    localStorage.setItem(JOB_KEY, JSON.stringify(job));
  } catch (_) {
    // 存不下也让它这次能用，只是下次要重新复刻
  }
}

/** 已经复刻过的音色 id（没有就是空串）。 */
export function clonedVoiceId() {
  const job = readJob();
  return job ? job.voiceId : '';
}

export function forgetClone() {
  try {
    localStorage.removeItem(JOB_KEY);
  } catch (_) {
    // ignore
  }
}

function makeVoiceId() {
  // minimax 要求 voice_id 够长（≥8 字符，实测 7 字符报 2013）；
  // 同时要能认出来源，前缀固定 ellen_
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return 'ellen_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function apiError(status, code) {
  if (code === 2038) return '先去国内 minimax 平台完成实名认证，再来复刻。';
  if (code === 1008 || status === 402) return 'minimax 余额不足，充值后再试。';
  if (code === 2049 || code === 1004 || status === 401 || status === 403) return '这个 key 不对，或者账号没开语音权限。';
  if (code === 1026 || code === 1027) return '平台没通过这份素材审核。';
  if (code === 2013) return '平台不接受这次请求的参数。';
  if (code === 1002 || code === 1039 || code === 1041 || code === 2045 || status === 429) return '请求太频繁，过一会儿再试。';
  return `复刻没成功${Number.isInteger(code) ? `（错误码 ${code}）` : ''}。`;
}

async function postJson(url, key, body, isForm) {
  const res = await fetch(url, {
    method: 'POST',
    headers: isForm ? { Authorization: `Bearer ${key}` } : { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body,
  });
  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    data = null;
  }
  const code = data && data.base_resp ? data.base_resp.status_code : undefined;
  const zero = code === 0 || code === '0';
  if (!res.ok || (data && data.base_resp && !zero)) {
    throw new Error(apiError(res.status, Number(code)));
  }
  if (!data) throw new Error('平台返回的数据看不懂，稍后再试。');
  return data;
}

/** 上传内置素材并复刻。onProgress(stage, text) 给界面显示进度。 */
export async function cloneVoice({ apiKey, onProgress } = {}) {
  const key = apiKey || (await readKey());
  if (!key) throw new Error('先填 minimax 的 key。');

  const existed = readJob();
  if (existed) return { voiceId: existed.voiceId, reused: true };

  const model = readPrefs().model || DEFAULT_MODEL;

  onProgress && onProgress('download', '正在读内置素材…');
  const audioRes = await fetch(REFERENCE);
  if (!audioRes.ok) throw new Error('内置素材读不出来，软件文件可能不完整。');
  const blob = await audioRes.blob();
  if (!blob.size) throw new Error('内置素材是空的，软件文件可能不完整。');

  onProgress && onProgress('upload', '正在上传素材…');
  const form = new FormData();
  form.set('purpose', 'voice_clone');
  form.set('file', blob, 'ellen-reference.mp3');
  const uploaded = await postJson(UPLOAD, key, form, true);
  const fileId = uploaded && uploaded.file ? uploaded.file.file_id : null;
  if (!fileId) throw new Error('平台没给素材编号，稍后再试。');

  const voiceId = makeVoiceId();
  onProgress && onProgress('clone', '正在复刻声音…');
  const cloned = await postJson(
    CLONE,
    key,
    JSON.stringify({ file_id: Number(fileId), voice_id: voiceId, model }),
  );
  if (cloned && cloned.input_sensitive) throw new Error('素材没通过平台审核。');

  writeJob({ voiceId, model, at: new Date().toISOString(), fileId: String(fileId) });
  writePrefs({ provider: 'minimax', voiceId });
  return { voiceId, reused: false };
}
