// 语音通话的状态机（纯逻辑，不碰 DOM、不碰录音、不碰 TTS）。
//
// 为什么单独拆一层：这一层的每条转移都要能脱离真机验证 ——「她说完话我开口但她没停」
// 「我沉默 12 秒她该不该出声」这类问题在手机上根本没法稳定复现，只能靠单测锁行为。
// 视图（ui/views/call/call.js）只负责把 event 翻译成「开录音 / 停 TTS / 显示提示」，
// 自己不做任何状态判断，避免两处各有一份 if 最后对不上。
//
// 状态图（五种，和需求文档对齐）：
//   idle ──start──▶ listening ──userSpoke──▶ thinking ──reply──▶ speaking
//                      ▲                        │                  │
//                      │                        │ asrFailed(<3)    │ speakDone（continuous）
//                      └────────────────────────┴──────────────────┘
//   speaking ──level() 持续有声音──▶ listening（打断，同时要求视图立刻 stop TTS）
//   任意态 ──hangup──▶ ended（视图负责释放麦克风与 TTS）

export const CALL_STATES = ['idle', 'listening', 'thinking', 'speaking', 'ended'];

/** 她不出声多久放一句提示音。太短会显得催，太长会让人以为断了。 */
export const SILENCE_CUE_MS = 12000;

/** 连续几次「没听清」才劝用户改用打字。一次就降级等于把话筒判死刑。 */
export const MAX_ASR_FAILS = 3;

/** 打断阈值：连续有声音超过这么久才算「用户开口」。一声咳嗽/关门不该打断她。 */
export const BARGE_IN_MS = 220;

/** 归一化 RMS 阈值（0..1）。环境噪声普遍在 0.02 以下，正常说话 0.08~0.3。 */
export const BARGE_IN_LEVEL = 0.055;

/** 静音判定：低于这个电平持续 QUIET_MS 就认为一轮说完了。 */
export const QUIET_LEVEL = 0.035;
export const QUIET_MS = 1100;

const PREFS_KEY = 'ellen.call.v1';

export const DEFAULT_CALL_PREFS = {
  // 一进来就免提：通话页本来就是「贴耳朵听」的场景，默认开免提更像打电话。
  handsFree: true,
  // 连续通话：她说完自动继续听。关掉 = 单轮通话，说完就挂。
  continuous: true,
};

export function readCallPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_CALL_PREFS };
    const parsed = JSON.parse(raw);
    return {
      handsFree: parsed.handsFree !== false,
      continuous: parsed.continuous !== false,
    };
  } catch {
    return { ...DEFAULT_CALL_PREFS };
  }
}

export function writeCallPrefs(patch) {
  const merged = { ...readCallPrefs(), ...patch };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(merged));
  } catch (err) {
    console.warn('[call] 存不下', err);
  }
  return merged;
}

export function resetCallPrefs() {
  try {
    localStorage.removeItem(PREFS_KEY);
  } catch {
    /* 清不掉就用默认值 */
  }
  return { ...DEFAULT_CALL_PREFS };
}

/** 通话时长：00:07 / 12:03 / 1:02:03。小时位只在真的过了一小时才出现。 */
export function formatCallDuration(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const two = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${two(m)}:${two(sec)}`;
}

/**
 * 造一台通话状态机。
 *
 * @param {object} opts
 * @param {() => number} [opts.now] 时钟（单测注入假时间）
 * @param {object} [opts.prefs] 初始偏好（continuous / handsFree）
 * @param {(evt: object) => void} [opts.onEvent] 状态变化回调
 */
export function createCallMachine({ now = () => Date.now(), prefs, onEvent } = {}) {
  const initial = { ...DEFAULT_CALL_PREFS, ...(prefs || readCallPrefs()) };

  let state = 'idle';
  let since = now();
  let fails = 0;          // 连续「没听清」次数，成功识别一次就归零
  let degraded = false;   // 已经劝过用户打字
  let muted = false;      // 上行静音：只管麦克风，不影响她说话
  let continuous = initial.continuous !== false;
  let loudMs = 0;         // speaking 态里累计的「有声音」时长
  let cueSent = false;    // 本次 listening 是否已经放过提示
  let heardAny = false;   // 本次 listening 是否听到过声音（用户确实在说）
  let startedAt = 0;
  const listeners = new Set();

  function emit(evt) {
    const e = { at: now(), state, ...evt };
    for (const fn of listeners) {
      try {
        fn(e);
      } catch (err) {
        console.warn('[call] 监听器抛了', err);
      }
    }
    if (typeof onEvent === 'function') {
      try {
        onEvent(e);
      } catch (err) {
        console.warn('[call] onEvent 抛了', err);
      }
    }
    return e;
  }

  function to(next, evt) {
    state = next;
    since = now();
    if (next === 'listening') {
      cueSent = false;
      heardAny = false;
      loudMs = 0;
    }
    return emit({ type: 'state', next, ...evt });
  }

  function failReset() {
    fails = 0;
    degraded = false;
  }

  return {
    get state() {
      return state;
    },

    snapshot() {
      return {
        state,
        since,
        startedAt,
        elapsedMs: startedAt ? now() - startedAt : 0,
        fails,
        degraded,
        muted,
        continuous,
        cueSent,
      };
    },

    subscribe(fn) {
      if (typeof fn !== 'function') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /** 开始通话：idle/ended → listening。视图收到 listen 事件才开麦克风。 */
    start() {
      if (state === 'listening' || state === 'thinking' || state === 'speaking') return this.snapshot();
      startedAt = now();
      fails = 0;
      degraded = false;
      const evt = to('listening');
      emit({ type: 'listen', listen: true });
      return { ...this.snapshot(), evt };
    },

    /** 挂断：任何态都能进。ended 之后不再自动进 listening。 */
    hangup(reason = 'user') {
      if (state === 'ended' || state === 'idle') return this.snapshot();
      to('ended', { reason });
      // 这一条是「挂断必须释放麦克风与 TTS」的唯一触发点：
      // 视图收到 release 就 cancel 录音 + stop 播报，漏了会一直占着话筒。
      emit({ type: 'release', reason, finalElapsedMs: startedAt ? now() - startedAt : 0 });
      return this.snapshot();
    },

    /** 电平输入（视图按 60~120ms 采样一次）。只在 speaking 态有效，用来判断被打断。 */
    level(rms, dtMs = 0) {
      const v = Number(rms) || 0;
      if (state === 'speaking') {
        const dt = Number(dtMs) > 0 ? Number(dtMs) : 80;
        if (v >= BARGE_IN_LEVEL) loudMs += dt;
        else loudMs = 0;
        if (loudMs >= BARGE_IN_MS) {
          const waited = loudMs;
          // 先转 listening 再发 barge-in：视图收到 barge-in 要立刻 stop TTS，
          // 这一帧的声音算用户的新一轮开头，不能丢。
          to('listening', { interrupted: true, waitedMs: waited });
          emit({ type: 'barge-in', waitedMs: waited });
          return true;
        }
        return false;
      }
      if (state === 'listening') {
        if (v >= BARGE_IN_LEVEL) {
          heardAny = true;
          // 用户确实在说话：把「沉默超时」的计时刷新，别在他讲到一半时放提示音。
          since = now();
        }
        return false;
      }
      return false;
    },

    /** 视图判定「这一轮说完了」（静音或按键收尾）→ listening → thinking。 */
    userSpoke() {
      if (state !== 'listening') return this.snapshot();
      to('thinking');
      emit({ type: 'transcribe' });
      return this.snapshot();
    },

    /** 识别回来的文字。空文本按「没听清」处理，不当成一轮正常对话。 */
    transcript(text) {
      const body = String(text || '').trim();
      if (state !== 'thinking') return this.snapshot();
      if (!body) return this.asrFailed('ASR_EMPTY');
      fails = 0;
      degraded = false;
      emit({ type: 'send', text: body });
      return this.snapshot();
    },

    /**
     * 识别失败：不挂断，提示「没听清」继续听；连续 3 次才劝用户打字。
     * 视图收到 notHeard 只显示一行提示，不做任何状态判断。
     */
    asrFailed(code = 'ASR_FAILED') {
      if (state === 'ended' || state === 'idle') return this.snapshot();
      fails += 1;
      if (fails < MAX_ASR_FAILS) {
        to('listening', { asrFailed: true, fails });
        emit({ type: 'notHeard', fails, code, retreat: false });
        return this.snapshot();
      }
      degraded = true;
      to('listening', { asrFailed: true, fails });
      // 降级只是「多说一句建议」，麦克风继续开着 —— 用户可能只是想再试一次。
      emit({ type: 'notHeard', fails, code, retreat: true });
      emit({ type: 'degrade', fails });
      return this.snapshot();
    },

    /** app 层拿到回复：thinking → speaking。回复为空就直接回去听。 */
    reply(text) {
      const body = String(text || '').trim();
      if (state !== 'thinking') return this.snapshot();
      if (!body) {
        to('listening');
        emit({ type: 'listen' });
        return this.snapshot();
      }
      failReset();
      to('speaking', { text: body });
      emit({ type: 'speak', text: body });
      return this.snapshot();
    },

    /** 她念完了：连续通话就自动接着听，关掉连续通话就结束这一通。 */
    speakDone() {
      if (state !== 'speaking') return this.snapshot();
      if (!continuous) {
        to('ended', { reason: 'one-turn' });
        emit({ type: 'release', reason: 'one-turn' });
        return this.snapshot();
      }
      to('listening');
      emit({ type: 'listen' });
      return this.snapshot();
    },

    /** 静音（只管上行：她还能继续说话）。 */
    setMuted(on) {
      muted = !!on;
      emit({ type: 'mute', on: muted });
      return this.snapshot();
    },

    toggleMute() {
      return this.setMuted(!muted);
    },

    setContinuous(on) {
      continuous = !!on;
      writeCallPrefs({ continuous });
      return this.snapshot();
    },

    /** 心跳：视图每 500ms 调一次，负责「她不出声 12 秒」这一条超时。 */
    tick(at = now()) {
      if (state !== 'listening') return this.snapshot();
      if (at - since < SILENCE_CUE_MS) return this.snapshot();
      // 已经听到过声音只是没说完，不该催；只有真的一片安静才放提示。
      if (heardAny) {
        since = at;
        return this.snapshot();
      }
      if (cueSent) return this.snapshot();
      cueSent = true;
      emit({ type: 'cue', silentMs: at - since });
      return this.snapshot();
    },

    /** 供视图重置一次「听到声音」的标记（用户开口后视图主动调）。 */
    noteHeard() {
      if (state !== 'listening') return;
      heardAny = true;
      since = now();
    },
  };
}
