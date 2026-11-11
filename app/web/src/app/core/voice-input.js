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
export const CANCEL_DY = 80;
export const CANCEL_HYST = 24;
/** 系统权限弹窗可能一直没人点：等这么久还没开录，就当成「没拿到权限」收场，别在 arming 装死。 */
export const START_TIMEOUT_MS = 8000;

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
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastY = 0;
  let cancelArmed = false;
  let fileId = '';
  let armTimer = null;
  let tickTimer = null;
  let maxTimer = null;
  let startGuard = null;
  let startPending = false;
  let runId = 0;

  function elapsed() {
    return startedAt ? Math.max(0, now() - startedAt) : 0;
  }

  function snapshot() {
    return { phase, ms: elapsed(), cancel: cancelArmed };
  }

  function emit(extra) {
    const st = extra ? Object.assign(snapshot(), extra) : snapshot();
    onState(st);
    for (const fn of listeners) {
      try { fn(st); } catch (err) { console.error('[voice-input] 订阅回调失败', err); }
    }
  }

  /**
   * 失败统一从这里出门：既给 app 层 onError（弹一句 flash），
   * 也顺着 state 广播一份 error —— 视图的录音浮层靠这个变红，
   * 否则权限被拒时界面会一声不吭，看着像按钮坏了。
   */
  function fail(code, message) {
    const err = { code, message };
    phase = 'idle';
    onError(err);
    emit({ error: err });
  }

  function clearTimers() {
    if (armTimer) { clearTimeout(armTimer); armTimer = null; }
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    if (maxTimer) { clearTimeout(maxTimer); maxTimer = null; }
    if (startGuard) { clearTimeout(startGuard); startGuard = null; }
  }

  function dropRecording() {
    const id = fileId;
    fileId = '';
    if (!id) return;
    recorder.release(id).catch(() => {});
  }

  async function begin() {
    const id = runId;
    // recorder.start() 在没授权时会先把系统权限弹窗挂起来，Promise 既不 resolve 也不 reject。
    // 没有这道守卫，界面会一直停在 arming（看着像按钮坏了）。
    if (startGuard) clearTimeout(startGuard);
    startGuard = setTimeout(() => {
      startGuard = null;
      if (id !== runId || phase !== 'arming') return;
      runId += 1;
      fail('AUDIO_PERMISSION', '等不到系统录音权限');
    }, START_TIMEOUT_MS);
    startPending = true;
    try {
      const res = await recorder.start({ maxDurationMs: MAX_MS });
      startPending = false;
      if (startGuard) { clearTimeout(startGuard); startGuard = null; }
      if (id !== runId) {
        // 权限/启动这 100ms 里用户已经松手或取消了
        recorder.cancel().catch(() => {});
        return;
      }
      fileId = (res && res.fileId) || '';
      // 计时从「真正开录」算，不含 300ms arming：语音条上的时长得对得上听到的长度
      startedAt = now();
      phase = 'recording';
      // 原点重锚：arming 那 300ms 里键盘收起、输入条变高，整页会位移，
      // 拿 pointerdown 时的 Y 当原点会算出假位移 —— 真机上「手一抖就取消」就是这么来的。
      startX = lastX;
      startY = lastY;
      cancelArmed = false;
      emit();
      maxTimer = setTimeout(() => { finalize(); }, MAX_MS);
    } catch (err) {
      startPending = false;
      clearTimers();
      fail((err && err.code) || 'AUDIO_FAILED', String((err && err.message) || err));
    }
  }

  function press(x, y) {
    if (phase !== 'idle') return snapshot();
    runId += 1;
    phase = 'arming';
    startedAt = now();
    startX = Number.isFinite(x) ? x : 0;
    startY = Number.isFinite(y) ? y : 0;
    lastX = startX;
    lastY = startY;
    cancelArmed = false;
    fileId = '';
    // arming 也要走表：界面靠 ms 判断「按下半天还没开录 = 卡在权限弹窗」
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(() => {
      if (phase === 'arming' || phase === 'recording' || phase === 'cancelling') emit();
    }, 200);
    emit();
    armTimer = setTimeout(() => {
      armTimer = null;
      if (phase === 'arming') begin();
    }, ARM_MS);
    return snapshot();
  }

  function move(x, y) {
    if (phase !== 'recording' && phase !== 'cancelling' && phase !== 'arming') return snapshot();
    const nx = Number.isFinite(x) ? x : startX;
    const ny = Number.isFinite(y) ? y : startY;
    lastX = nx;
    lastY = ny;
    const dy = ny - startY;
    const dx = nx - startX;
    // 三条一起过才允许进取消，缺一条都会被「手一抖」误触发：
    //   ① 往上滑够 CANCEL_DY（80 CSS px ≈ 4~5 mm）
    //   ② 纵向位移至少是横向的 1.5 倍（斜着划、横向挪手指不算取消）
    //   ③ 迟滞：已经进了取消态要退回 CANCEL_HYST 之内才解除
    const vertical = Math.abs(dy) > Math.abs(dx) * 1.5;
    const pass = vertical && dy <= -CANCEL_DY;
    const next = cancelArmed ? vertical && dy <= -(CANCEL_DY - CANCEL_HYST) : pass;
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
        fail((err && err.code) || 'AUDIO_FAILED', String((err && err.message) || err));
        return;
      }
    }

    if (durationMs < MIN_MS) {
      phase = 'idle';
      emit();
      dropRecording();
      fail('VOICE_TOO_SHORT', '太短了，再说一遍呗');
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
      fail((err && err.code) || 'AUDIO_READ_FAILED', String((err && err.message) || err));
      return;
    }
    // 录音文件只是转写的原料，读出来就能删（真正的语音条会另存到 attachments）
    dropRecording();

    if (!base64) {
      phase = 'idle';
      emit();
      fail('AUDIO_EMPTY', '这段录音是空的。');
      return;
    }

    try {
      await onCommit({ base64, durationMs });
    } catch (err) {
      fail((err && err.code) || 'VOICE_COMMIT_FAILED', String((err && err.message) || err));
    } finally {
      if (id === runId) {
        phase = 'idle';
        emit();
      }
    }
  }

  function release() {
    if (phase === 'arming') {
      // 按下去超过 arming 却还没开录：多半是系统权限弹窗挂着没人点。
      // 这时候当「误触」静默收场最坑人——手指明明按了好久，界面一声不吭。
      const blocked = startPending && elapsed() >= ARM_MS;
      runId += 1;
      clearTimers();
      startPending = false;
      phase = 'idle';
      if (blocked) {
        fail('AUDIO_PERMISSION', '没拿到系统录音权限');
        return snapshot();
      }
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
