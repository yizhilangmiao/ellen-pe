// 录音。原生 EllenAudio 把 16 kHz 单声道 s16le 包成 WAV 落在 filesDir/recordings/，
// web 只负责开/停与把字节取回来。
//
// 为什么不用 MediaRecorder / WebAudio：转写接口要的是「PCM 包成 WAV」这种最朴素的东西，
// WebView 里录出来的 webm/opus 还得转一遍，反而多一步依赖。原生直出 WAV 最省事。
import { call } from './native/bridge.js';

const MAX_MS = 120000;

function newId() {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `rec-${stamp}-${rand}`;
}

export async function available() {
  try {
    const caps = await call('EllenAudio', 'capabilities', {});
    return !!(caps && caps.record);
  } catch (err) {
    return false;
  }
}

export async function state() {
  try {
    return await call('EllenAudio', 'state', {});
  } catch (err) {
    return { recording: false, elapsedMs: 0, bytes: 0, lastError: String(err && err.message ? err.message : err) };
  }
}

export async function start(opts = {}) {
  const fileId = opts.fileId || newId();
  const res = await call('EllenAudio', 'startRecording', {
    fileId,
    maxDurationMs: opts.maxDurationMs || MAX_MS,
  });
  return { ...res, fileId: res && res.fileId ? res.fileId : fileId };
}

export async function stop() {
  const res = await call('EllenAudio', 'stopRecording', {});
  return res;
}

export async function cancel() {
  try {
    await call('EllenAudio', 'cancelRecording', {});
  } catch (err) {
    // 取消不成就当没在录
  }
  return { cancelled: true };
}

/** 取回 WAV 的 base64（给 asr 用，也给「存成语音条」留口）。 */
export async function readBase64(fileId) {
  return await call('EllenAudio', 'readRecording', { fileId });
}

export async function release(fileId) {
  try {
    await call('EllenAudio', 'releaseRecording', { fileId });
  } catch (err) {
    // 删不掉就留着，别报错
  }
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}
