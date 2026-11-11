// 语音消息：把一段录音变成「一条能落库、重启还能播的语音条」。
//
// 两条分工：
//   peaksFromWav(base64, n)            纯函数：解 WAV 头 + 16bit PCM，按 n 段算 RMS 归一
//   prepareVoice({base64, durationMs}) 落盘 + 转写，返回 {audio, speech}
//
// speech 单独存一份：界面永不渲染它，只有喂模型时用 text（见 chat/session.js）。
// 转写失败也必须发出去——不能让一次没听清把用户说的话吞掉。
import { saveDocument, listDocuments, removeDocument } from './documents.js';
import { transcribe } from './asr.js';

const FALLBACK_HEADER = 44;

function fourcc(bytes, offset) {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

/** 走一遍 RIFF 块，拿到 fmt（声道/位深）与 data（偏移/长度）。坏的 WAV 退回 44 字节头。 */
function readWavLayout(bytes) {
  const fallback = { offset: FALLBACK_HEADER, size: Math.max(0, bytes.length - FALLBACK_HEADER), channels: 1, bits: 16 };
  if (bytes.length < FALLBACK_HEADER) return null;
  if (fourcc(bytes, 0) !== 'RIFF' || fourcc(bytes, 8) !== 'WAVE') return fallback;
  let pos = 12;
  let channels = 1;
  let bits = 16;
  while (pos + 8 <= bytes.length) {
    const id = fourcc(bytes, pos);
    const size =
      bytes[pos + 4] | (bytes[pos + 5] << 8) | (bytes[pos + 6] << 16) | (bytes[pos + 7] << 24);
    if (id === 'fmt ' && pos + 23 < bytes.length) {
      channels = bytes[pos + 10] | (bytes[pos + 11] << 8) || 1;
      bits = bytes[pos + 22] | (bytes[pos + 23] << 8) || 16;
    }
    if (id === 'data') {
      const start = pos + 8;
      return { offset: start, size: Math.min(Math.max(0, size), bytes.length - start), channels, bits };
    }
    pos += 8 + Math.max(0, size) + (size % 2);
  }
  return fallback;
}

function bytesOf(base64) {
  const raw = String(base64 || '').replace(/^data:[^,]*,/, '');
  const bin = atob(raw);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * 从 WAV 的 base64 算 n 个波形柱（0-100 的整数）。
 * 只认 16bit PCM（原生录音就是 16k/单声道/16bit）；别的位深退回「等长平铺」，不抛错。
 */
export function peaksFromWav(base64, n = 14) {
  const count = Math.max(1, Math.min(64, Math.round(Number(n) || 14)));
  let bytes;
  try {
    bytes = bytesOf(base64);
  } catch (err) {
    return new Array(count).fill(38);
  }
  const layout = readWavLayout(bytes);
  if (!layout || layout.bits !== 16 || layout.size < 2) return new Array(count).fill(38);

  const channels = Math.max(1, layout.channels | 0);
  const frameBytes = 2 * channels;
  const frames = Math.floor(layout.size / frameBytes);
  if (!frames) return new Array(count).fill(38);

  const view = new DataView(bytes.buffer, bytes.byteOffset + layout.offset, layout.size);
  const segment = Math.max(1, Math.floor(frames / count));
  const peaks = [];
  for (let seg = 0; seg < count; seg += 1) {
    const from = seg * segment;
    const to = seg === count - 1 ? frames : Math.min(frames, from + segment);
    let sum = 0;
    let used = 0;
    for (let f = from; f < to; f += 1) {
      // 多声道取第一声道就够（原生是单声道，这里只是别炸）
      const sample = view.getInt16(f * frameBytes, true) / 32768;
      sum += sample * sample;
      used += 1;
    }
    peaks.push(used ? Math.sqrt(sum / used) : 0);
  }

  const max = Math.max(...peaks);
  if (!max) return new Array(count).fill(12);
  return peaks.map((v) => {
    const norm = Math.round((v / max) * 100);
    return Math.max(8, Math.min(100, norm));
  });
}

/** 转写失败时喂给模型的占位话（界面只画波形，不显示这句话）。 */
export function voicePlaceholder(durationMs) {
  const sec = Math.max(1, Math.round((Number(durationMs) || 0) / 1000));
  return `（语音 ${sec} 秒，没听清）`;
}

/**
 * 一条录音 → 一条语音消息。
 * 先落盘（durable，重启还在），再转写（离线优先，失败不抛），最后算波形。
 * @param {{base64: string, durationMs: number}} input
 * @returns {Promise<{audio: object, speech: object}>}
 */
export async function prepareVoice({ base64, durationMs }) {
  const ms = Math.max(0, Math.round(Number(durationMs) || 0));
  if (!base64) throw Object.assign(new Error('这条语音是空的。'), { code: 'VOICE_EMPTY' });

  // 1. 落盘：这条路挂了就没有语音条，必须把错误抛上去（视图会提示）
  const saved = await saveDocument(base64, `voice-${Date.now()}.wav`);

  // 2. 转写：失败不抛——界面只有波形，模型收到一句「没听清」
  let text = '';
  let failed = false;
  let reason = '';
  try {
    const res = await transcribe({ base64 });
    text = String((res && res.text) || '').trim();
  } catch (err) {
    failed = true;
    reason = String((err && err.code) || 'ASR_FAILED');
  }
  if (!text) {
    failed = true;
    text = voicePlaceholder(ms);
  }

  // 3. 波形：算一次就永久存库里（播放时不再解码第二遍）
  const peaks = peaksFromWav(base64, 14);

  return {
    audio: {
      uri: saved.uri,
      name: saved.name,
      bytes: saved.bytes,
      durationMs: ms,
      peaks,
    },
    speech: {
      text,
      at: Date.now(),
      failed,
      ...(reason ? { code: reason } : {}),
    },
  };
}

/** 语音上限与「最少留几条」。
 *  200 MB 是老大定的。keepNewest 取 20：一条语音约 1~2 MB，20 条 ≈ 40 MB，
 *  既保证最近二十句一定能播，又不会大到把 200 MB 的闸门顶穿（留 200 条就没法触发清理了）。 */
export const VOICE_MAX_BYTES = 200 * 1024 * 1024;
export const VOICE_KEEP_NEWEST = 20;

/** 看一眼语音占了多少。 */
export async function voiceStorage() {
  return listDocuments({ prefix: 'voice-' });
}

/**
 * 超上限就从最老的开始删（原生已按 mtime 新→旧排好，所以从尾部取），
 * 但至少留 keepNewest 条。删不掉的文件跳过、不中断——少删一个比删一半崩掉好。
 */
export async function pruneVoices({ maxBytes = VOICE_MAX_BYTES, keepNewest = VOICE_KEEP_NEWEST } = {}) {
  const res = await listDocuments({ prefix: 'voice-' });
  const files = res.files || [];
  const before = res.totalBytes;
  if (before <= maxBytes) {
    return { removed: [], freedBytes: 0, totalBytes: before, kept: files.length, truncated: res.truncated };
  }
  const floor = Math.min(keepNewest, files.length);
  const removed = [];
  let freed = 0;
  for (let i = files.length - 1; i >= floor; i -= 1) {
    if (before - freed <= maxBytes) break;
    const file = files[i];
    try {
      await removeDocument(file.uri);
      freed += Number(file.bytes || 0);
      removed.push(file.name);
    } catch (err) {
      console.warn('[voice] 删不掉，跳过', file.name, err);
    }
  }
  return { removed, freedBytes: freed, totalBytes: before - freed, kept: files.length - removed.length, truncated: res.truncated };
}
