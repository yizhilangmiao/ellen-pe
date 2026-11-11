// 按住说话的录音状态机。只算状态，不碰 DOM（视图订阅 onState 自己画）。
//
//   idle -> arming(300ms) -> recording -> (cancelling) -> transcribing -> idle
//
// 三条边界（都是实测踩出来的）：
//  1. 按下 < 300ms 松手 = 误触，静默回到 idle，不出「太短了」——手指擦一下不该弹提示；
//  2. 录了但 < 700ms 松手 = 真按了但没说完，出 VOICE_TOO_SHORT；
//  3. 上滑超过 48px 进取消态，滑回阈值带 8px 迟滞，否则在阈值上抖会一直闪红。
import * as defaultRecorder from './recorder.js';

export const ARM_MS = 300;
export const MIN_MS = 700;
export const MAX_MS = 60000;
export const CANCEL_DY = 48;
export const CANCEL_HYST = 8;

export function createVoiceInput(options = {}) {
  const onState = typeof options.onState === 'function' ? options.onState : () => {};
  const onCommit = typeof options.onCommit === 'function' ? options.onCommit : () => {};
  const onCancel = typeof options.onCancel === 'function' ? options.onCancel : () => {};
  const onError = typeof options.onError === 'function' ? options.onError : () => {};
  // recorder / now 可注入（单测在 node 里跑，不碰原生）
  const recorder = options.recorder || defaultRecorder;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const listeners = new Set();

  let phase = 'idle';
  let startedAt = 0;
  let startY = 0;
  let cancelArmed = false;
  let fileId = '';
  let armTimer = null;
  let tickTimer = null;
  let maxTimer = null;
  let runId = 0;

  function elapsed() {
    return startedAt ? Math.max(0, now() - startedAt) : 0;
  }

  function snapshot() {
    return { phase, ms: elapsed(), cancel: cancelArmed };
  }

  function emit() {
    const st = snapshot();
    onState(st);
    for (const fn of listeners) {
      try { fn(st); } catch (err) { console.error('[voice-input] 订阅回调失败', err); }
    }
  }

  function clearTimers() {
    if (armTimer) { clearTimeout(armTimer); armTimer = null; }
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    if (maxTimer) { clearTimeout(maxTimer); maxTimer = null; }
  }

  function dropRecording() {
    const id = fileId;
    fileId = '';
    if (!id) return;
    recorder.release(id).catch(() => {});
  }

  async function begin() {
    const id = runId;
    try {
      const res = await recorder.start({ maxDurationMs: MAX_MS });
      if (id !== runId) {
        // 权限/启动这 100ms 里用户已经松手或取消了
        recorder.cancel().catch(() => {});
        return;
      }
      fileId = (res && res.fileId) || '';
      // 计时从「真正开录」算，不含 300ms arming：语音条上的时长得对得上听到的长度
      startedAt = now();
      phase = 'recording';
      emit();
      tickTimer = setInterval(() => {
        if (phase === 'recording' || phase === 'cancelling') emit();
      }, 200);
      maxTimer = setTimeout(() => { finalize(); }, MAX_MS);
    } catch (err) {
      clearTimers();
      phase = 'idle';
      emit();
      onError({ code: (err && err.code) || 'AUDIO_FAILED', message: String((err && err.message) || err) });
    }
  }

  function press(x, y) {
    if (phase !== 'idle') return snapshot();
    runId += 1;
    phase = 'arming';
    startedAt = now();
    startY = Number.isFinite(y) ? y : 0;
    cancelArmed = false;
    fileId = '';
    emit();
    armTimer = setTimeout(() => {
      armTimer = null;
      if (phase === 'arming') begin();
    }, ARM_MS);
    return snapshot();
  }

  function move(x, y) {
    if (phase !== 'recording' && phase !== 'cancelling' && phase !== 'arming') return snapshot();
    const dy = (Number.isFinite(y) ? y : startY) - startY;
    // 进取消要滑过 48px；退回要滑到 40px 以内才算数（8px 迟滞，防阈值上抖红）
    const next = cancelArmed ? dy <= -(CANCEL_DY - CANCEL_HYST) : dy <= -CANCEL_DY;
    if (next !== cancelArmed) {
      cancelArmed = next;
      if (phase === 'cancelling' || phase === 'recording') phase = next ? 'cancelling' : 'recording';
      emit();
    }
    return snapshot();
  }

  async function finalize() {
    if (phase !== 'recording' && phase !== 'cancelling') return;
    const elapsedMs = elapsed();
    const cancelled = cancelArmed;
    const id = runId;
    clearTimers();

    if (cancelled) {
      phase = 'idle';
      emit();
      await recorder.cancel().catch(() => {});
      dropRecording();
      onCancel();
      return;
    }

    let durationMs = elapsedMs;
    let stopped = null;
    if (!cancelled) {
      try {
        stopped = await recorder.stop();
        if (stopped && Number.isFinite(stopped.durationMs) && stopped.durationMs > 0) {
          durationMs = stopped.durationMs;
        }
      } catch (err) {
        phase = 'idle';
        dropRecording();
        emit();
        onError({ code: (err && err.code) || 'AUDIO_FAILED', message: String((err && err.message) || err) });
        return;
      }
    }

    if (durationMs < MIN_MS) {
      phase = 'idle';
      emit();
      dropRecording();
      onError({ code: 'VOICE_TOO_SHORT', message: '太短了，再说一遍呗' });
      return;
    }

    phase = 'transcribing';
    emit();

    let base64 = '';
    try {
      const res = await recorder.readBase64(fileId);
      base64 = (res && (res.base64 || res.data)) || '';
    } catch (err) {
      phase = 'idle';
      dropRecording();
      emit();
      onError({ code: (err && err.code) || 'AUDIO_READ_FAILED', message: String((err && err.message) || err) });
      return;
    }
    // 录音文件只是转写的原料，读出来就能删（真正的语音条会另存到 attachments）
    dropRecording();

    if (!base64) {
      phase = 'idle';
      emit();
      onError({ code: 'AUDIO_EMPTY', message: '这段录音是空的。' });
      return;
    }

    try {
      await onCommit({ base64, durationMs });
    } catch (err) {
      onError({ code: (err && err.code) || 'VOICE_COMMIT_FAILED', message: String((err && err.message) || err) });
    } finally {
      if (id === runId) {
        phase = 'idle';
        emit();
      }
    }
  }

  function release() {
    if (phase === 'arming') {
      // < 300ms 当误触：不出提示，不转写
      runId += 1;
      clearTimers();
      phase = 'idle';
      emit();
      return snapshot();
    }
    finalize();
    return snapshot();
  }

  function cancel() {
    if (phase === 'idle' || phase === 'transcribing') return snapshot();
    runId += 1;
    clearTimers();
    phase = 'idle';
    emit();
    recorder.cancel().catch(() => {});
    dropRecording();
    onCancel();
    return snapshot();
  }

  return {
    press,
    move,
    release,
    cancel,
    state: snapshot,
    // 视图/验收脚本订阅状态用；不在 lead 的契约里，但比轮询干净
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
