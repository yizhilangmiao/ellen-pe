// 语音通话页（全屏，从聊天页顶栏的「通话」进入）。
//
// 分工：core/call.js 决定「现在该干什么」（状态机），本文件只把事件翻译成动作
// （开录音 / 转写 / 发一轮 / 念回复 / 停播报 / 释放）。为什么不在视图里写状态判断：
// 打断、超时、连续失败降级这三件事在真机上几乎没法复现，状态机必须是可单测的纯逻辑。
//
// 硬约束：麦克风只在用户点「开始通话」时才申请（原生 startRecording 才会拉起权限）；
// 挂断一律走 machine.hangup() → release 事件 → teardown()，麦克风与 TTS 同时释放。
import { iconEl } from '../../icons.js';
import portraitUrl from '../../../assets/ellen-portrait.webp';
import * as recorder from '../../../core/recorder.js';
import { transcribe } from '../../../core/asr.js';
import { speak, stop as stopSpeech, state as speechState } from '../../../core/speech.js';
import {
  createCallMachine,
  formatCallDuration,
  readCallPrefs,
  writeCallPrefs,
} from '../../../core/call.js';
import './call.css';

// 文案先放本地常量：strings.zh.js 这一轮不归我写（lead 正在里面加通话/通话设置的键）。
// 报给 lead 的键名见报告；搬进 strings.zh.js 后把这里换成 s('call.xxx') 即可。
const T = {
  back: '返回',
  title: '语音通话',
  idle: '按一下开始',
  listening: '我在听…',
  thinking: '我在想…',
  speaking: '她在说',
  ended: '通话结束',
  start: '开始通话',
  hangup: '挂断',
  mute: '静音',
  unmute: '取消静音',
  speaker: '免提',
  speakerOff: '听筒',
  notHeard: '没听清，再说一次',
  degrade: '试了几次都没听清，要不改用打字？',
  cue: '还在吗？',
  muted: '你静音了，说话我这边听不见',
  noRecorder: '这台设备录不了音',
  signal: '信号不太好，你再说一次',
  tapToStop: '说完点一下屏幕',
  interrupted: '你开口了，我先停一下',
};

// 一轮最多录多久。原生没有电平接口（EllenAudio.capabilities 只给 record/transcribe），
// 拿不到「用户说完了」这个信号，所以按固定窗口收尾，同时允许点屏幕提前结束。
// 4.5 秒够说一句话，又不至于让人对着手机干等。
const CAPTURE_MS = 4500;

/** 打断阈值：连续这么久有声音就让状态机判「用户开口」。与 core/call.js 的 BARGE_IN_* 对齐。 */
const PROBE_INTERVAL_MS = 80;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createCallView(props = {}) {
  return {
    mount(el) {
      el.classList.add('el-call-page');
      el.innerHTML = '';

      let machine = null;
      let capturing = false;
      let captureFileId = '';
      let captureTimer = 0;
      let captureDeadline = 0;
      let tickTimer = 0;
      let clockTimer = 0;
      let speechToken = 0;   // 每次停播报/挂断自增：等在途的「念完」轮询自己退出
      let probe = null;      // WebAudio 探针（只在 speaking 态开）
      let busy = false;      // 一轮请求在飞，防重复发
      let noteTimer = 0;

      // —— 骨架 ——
      const top = document.createElement('div');
      top.className = 'el-call-top';

      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'el-call-back';
      back.append(iconEl('back'));
      back.setAttribute('aria-label', T.back);

      const timer = document.createElement('span');
      timer.className = 'el-call-timer';
      timer.textContent = '00:00';

      top.append(back, timer);

      const stage = document.createElement('div');
      stage.className = 'el-call-stage';

      const portrait = document.createElement('div');
      portrait.className = 'el-call-portrait';
      const face = document.createElement('img');
      face.src = portraitUrl;
      face.alt = '';
      portrait.append(face);

      // 音量条：没有真实电平，用状态驱动的动画表达「在听 / 在想 / 在说」。
      // 真接上电平后把 bars 的 scale 换成 RMS 即可，结构不用改。
      const wave = document.createElement('div');
      wave.className = 'el-call-wave';
      const bars = [];
      for (let i = 0; i < 5; i += 1) {
        const bar = document.createElement('span');
        bar.className = 'el-call-bar';
        bar.dataset.i = String(i);
        wave.append(bar);
        bars.push(bar);
      }

      stage.append(portrait, wave);

      const status = document.createElement('div');
      status.className = 'el-call-status';
      status.textContent = T.idle;

      const note = document.createElement('div');
      note.className = 'el-call-note';
      note.hidden = true;

      const actions = document.createElement('div');
      actions.className = 'el-call-actions';

      // 静音：只管上行。她照样能说，只是我们不开麦克风。
      const muteBtn = document.createElement('button');
      muteBtn.type = 'button';
      muteBtn.className = 'el-call-act';
      muteBtn.append(iconEl('mic'));
      const muteLabel = document.createElement('span');
      muteLabel.className = 'el-call-act-label';
      muteLabel.textContent = T.mute;
      muteBtn.append(muteLabel);

      // 免提：只是开关状态（原生 play:false，实际走系统 TTS 的扬声器路由），
      // 所以这里记录偏好、给视觉反馈，不假装能切音频路由。
      const spkBtn = document.createElement('button');
      spkBtn.type = 'button';
      spkBtn.className = 'el-call-act';
      spkBtn.append(iconEl('volume'));
      const spkLabel = document.createElement('span');
      spkLabel.className = 'el-call-act-label';
      spkLabel.textContent = T.speaker;
      spkBtn.append(spkLabel);

      // 主按钮：未开始 = 开始通话，进行中 = 挂断。同一个位置，拇指不用挪。
      const mainBtn = document.createElement('button');
      mainBtn.type = 'button';
      mainBtn.className = 'el-call-main';
      mainBtn.append(iconEl('mic'));
      const mainLabel = document.createElement('span');
      mainLabel.className = 'el-call-act-label';
      mainLabel.textContent = T.start;
      mainBtn.append(mainLabel);

      actions.append(muteBtn, spkBtn, mainBtn);

      el.append(top, stage, status, note, actions);

      // —— 小工具 ——
      function setStatus(text) {
        status.textContent = text || '';
      }

      function setNote(text, bad) {
        clearTimeout(noteTimer);
        if (!text) {
          note.hidden = true;
          note.textContent = '';
          return;
        }
        note.hidden = false;
        note.textContent = text;
        note.classList.toggle('is-bad', !!bad);
        // 提示是「过一下就好」的东西，别永久占位把动作区往下顶。
        noteTimer = setTimeout(() => {
          note.hidden = true;
        }, 4200);
      }

      function paintMute() {
        const on = machine ? machine.snapshot().muted : false;
        muteBtn.classList.toggle('is-on', on);
        muteLabel.textContent = on ? T.unmute : T.mute;
        muteBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      }

      function paintLive(live) {
        el.classList.toggle('is-live', !!live);
        mainBtn.classList.toggle('is-live', !!live);
        mainBtn.innerHTML = '';
        mainBtn.append(iconEl(live ? 'stop' : 'mic'));
        const label = document.createElement('span');
        label.className = 'el-call-act-label';
        label.textContent = live ? T.hangup : T.start;
        mainBtn.append(label);
      }

      function paintState() {
        const st = machine ? machine.snapshot() : { state: 'idle' };
        el.dataset.state = st.state;
        if (st.state === 'idle') setStatus(T.idle);
        else if (st.state === 'listening') setStatus(T.listening);
        else if (st.state === 'thinking') setStatus(T.thinking);
        else if (st.state === 'speaking') setStatus(T.speaking);
        else if (st.state === 'ended') setStatus(T.ended);
      }

      // —— 电平探针（只在 speaking 态开）——
      // 为什么用 WebAudio：原生没有电平接口，而 TTS 播放时麦克风是空闲的，
      // 这段时间开一条 getUserMedia 只做分析、不录音，和原生录音不会抢设备。
      async function startProbe() {
        if (probe) return;
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        let stream = null;
        let ctx = null;
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          ctx = new Ctx();
          const src = ctx.createMediaStreamSource(stream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 512;
          src.connect(analyser);
          const buf = new Float32Array(analyser.fftSize);
          const timerId = setInterval(() => {
            analyser.getFloatTimeDomainData(buf);
            let sum = 0;
            for (let i = 0; i < buf.length; i += 1) sum += buf[i] * buf[i];
            const rms = Math.sqrt(sum / buf.length);
            if (machine) machine.level(rms, PROBE_INTERVAL_MS);
          }, PROBE_INTERVAL_MS);
          probe = { stream, ctx, timerId };
        } catch (err) {
          // 拿不到就退化：用户点屏幕打断（stage 的 click 已覆盖），不阻塞通话。
          if (stream) stream.getTracks().forEach((t) => t.stop());
          if (ctx) ctx.close().catch(() => {});
          probe = null;
        }
      }

      function stopProbe() {
        if (!probe) return;
        clearInterval(probe.timerId);
        try {
          probe.stream.getTracks().forEach((t) => t.stop());
        } catch (_) {
          /* 已经关了 */
        }
        try {
          probe.ctx.close();
        } catch (_) {
          /* 已经关了 */
        }
        probe = null;
      }

      // —— 一轮：录音 → 转写 ——
      async function beginCapture() {
        if (!machine) return;
        if (capturing || busy) return;
        const snap = machine.snapshot();
        if (snap.state !== 'listening') return;
        if (snap.muted) {
          setNote(T.muted, true);
          return;
        }
        // 探针和原生录音会抢麦克风：先关探针再开录音。
        stopProbe();
        capturing = true;
        try {
          const ok = await recorder.available();
          if (!ok) {
            setNote(T.noRecorder, true);
            machine.hangup('no-recorder');
            return;
          }
          const res = await recorder.start({ maxDurationMs: CAPTURE_MS });
          captureFileId = (res && res.fileId) || '';
          captureDeadline = Date.now() + CAPTURE_MS;
          clearTimeout(captureTimer);
          captureTimer = setTimeout(() => {
            endCapture('window');
          }, CAPTURE_MS);
        } catch (err) {
          capturing = false;
          setNote(T.signal, true);
          machine.asrFailed('REC_START');
        }
      }

      async function endCapture(reason = 'window') {
        if (!capturing) return;
        capturing = false;
        clearTimeout(captureTimer);
        captureTimer = 0;
        const fileId = captureFileId;
        const startedAt = captureDeadline ? captureDeadline - CAPTURE_MS : 0;
        captureFileId = '';
        const ms = startedAt ? Date.now() - startedAt : 0;

        // 静音：这一段直接丢掉，别送去识别（用户刚说完「别听」）。
        if (reason === 'mute') {
          try {
            await recorder.cancel();
          } catch (_) {
            /* 已经停了 */
          }
          releaseFile(fileId);
          return;
        }
        // 点一下就走（不到 0.6 秒）：当没听清，别把一声气音发给 ASR 白花一次请求。
        if (reason === 'tap' && ms < 600) {
          try {
            await recorder.cancel();
          } catch (_) {
            /* 已经停了 */
          }
          releaseFile(fileId);
          setNote(T.notHeard, true);
          machine.asrFailed('ASR_TOO_SHORT');
          return;
        }
        machine.userSpoke();
        try {
          await recorder.stop();
        } catch (_) {
          /* 已经停了 */
        }
        let base64 = '';
        try {
          const read = await recorder.readBase64(fileId);
          base64 = (read && (read.base64 || read.data)) || '';
        } catch (err) {
          base64 = '';
        }
        if (!base64) {
          releaseFile(fileId);
          machine.asrFailed('ASR_EMPTY_AUDIO');
          return;
        }
        try {
          const res = await transcribe({ fileId, base64 });
          machine.transcript(res && res.text);
        } catch (err) {
          machine.asrFailed((err && err.code) || 'ASR_FAILED');
        } finally {
          releaseFile(fileId);
        }
      }

      function releaseFile(fileId) {
        if (!fileId) return;
        try {
          recorder.release(fileId).catch(() => {});
        } catch (_) {
          /* 原生没实现就跳过 */
        }
      }

      // —— 一轮：发出去 → 念回来 ——
      async function runTurn(text) {
        if (busy) return;
        busy = true;
        try {
          const reply = await props.turn(text);
          busy = false;
          machine.reply(reply);
        } catch (err) {
          busy = false;
          setNote(T.signal, true);
          // 网络挂了不算「没听清」：回 listening 再来一轮，不动失败计数。
          machine.reply('');
        }
      }

      async function playReply(text) {
        const token = (speechToken += 1);
        // 打断监听先开起来：她一开始念，用户随时可能开口。
        startProbe();
        let started = false;
        try {
          const res = await speak(text);
          started = !!(res && res.speaking);
        } catch (err) {
          started = false;
        }
        if (token !== speechToken) return;
        if (!started) {
          // 念不出来（没配 key 又没系统 TTS）就别卡在 speaking 态。
          setNote(T.signal, true);
          stopProbe();
          machine.speakDone();
          return;
        }
        await waitSpeechEnd(text, token);
      }

      // 原生 speech 事件只给 start/done/error，云端播放又没有回调，
      // 所以「念完了吗」用轮询 + 时长上限兜底：宁可多等一下，也别提前打断她的话。
      async function waitSpeechEnd(text, token) {
        const cap = Math.min(30000, 900 + String(text || '').length * 280);
        const t0 = Date.now();
        while (Date.now() - t0 < cap) {
          await sleep(220);
          if (token !== speechToken) return;
          if (machine && machine.state !== 'speaking') return;
          const st = await speechState().catch(() => null);
          if (token !== speechToken) return;
          if (Date.now() - t0 > 700 && st && st.speaking === false) break;
        }
        if (token !== speechToken) return;
        stopProbe();
        if (machine && machine.state === 'speaking') machine.speakDone();
      }

      /** 立刻停播报并让在途的轮询作废。打断与挂断都走这里。 */
      function cutSpeech() {
        speechToken += 1;
        stopProbe();
        stopSpeech().catch(() => {});
      }

      // —— 状态机事件 ——
      // 「没听清」之后状态机只是回到 listening，不会再发一次 listen 事件
      // （listen 只代表「进入 listening」这一次转移）。而实际需要的是「重新开麦」，
      // 所以失败提示之后由视图自己补一次采集 —— 漏了这一步，用户就对着一个死麦说话。
      let kickTimer = 0;
      function kickCapture(delay = 240) {
        clearTimeout(kickTimer);
        kickTimer = setTimeout(() => {
          if (!machine) return;
          if (machine.state !== 'listening') return;
          if (capturing || busy) return;
          beginCapture();
        }, delay);
      }

      function onEvent(evt) {
        paintState();
        switch (evt.type) {
          case 'listen':
            beginCapture();
            break;
          case 'transcribe':
            setStatus(T.thinking);
            break;
          case 'send':
            runTurn(evt.text);
            break;
          case 'speak':
            playReply(evt.text);
            break;
          case 'barge-in':
            cutSpeech();
            setNote(T.interrupted);
            break;
          case 'notHeard':
            setNote(evt.retreat ? T.degrade : T.notHeard, true);
            kickCapture();
            break;
          case 'cue':
            // 超时提示：她主动问一句，走同一条播报链路，但不进 speaking 态
            // （状态机还在 listening，用户开口就被打断，逻辑上是一句话外挂）。
            speak(T.cue).catch(() => {});
            break;
          case 'mute':
            paintMute();
            // 取消静音后如果正停在 listening，应该马上重新开麦
            if (!evt.on) kickCapture(120);
            break;
          case 'release':
            teardown(evt.reason);
            break;
          default:
            break;
        }
      }

      function teardown(reason) {
        capturing = false;
        clearTimeout(kickTimer);
        clearTimeout(captureTimer);
        captureTimer = 0;
        clearInterval(tickTimer);
        clearInterval(clockTimer);
        tickTimer = 0;
        clockTimer = 0;
        cutSpeech();
        recorder.cancel().catch(() => {});
        if (captureFileId) {
          releaseFile(captureFileId);
          captureFileId = '';
        }
        paintLive(false);
        paintState();
        if (reason === 'one-turn') setStatus(T.ended);
        if (typeof props.onEnd === 'function') {
          try {
            props.onEnd(reason, machine ? machine.snapshot() : null);
          } catch (_) {
            /* 外部回调出错不影响释放 */
          }
        }
      }

      function startCall() {
        const prefs = readCallPrefs();
        machine = machine || createCallMachine({ prefs, onEvent });
        paintLive(true);
        machine.start();
        setNote(T.tapToStop);
        // 计时与心跳都从「真的开始了」才走，别在 idle 页面上空转。
        clearInterval(clockTimer);
        clockTimer = setInterval(() => {
          const snap = machine.snapshot();
          timer.textContent = formatCallDuration(snap.elapsedMs);
        }, 1000);
        clearInterval(tickTimer);
        tickTimer = setInterval(() => machine.tick(), 500);
      }

      function hangup(reason = 'user') {
        if (!machine) return;
        machine.hangup(reason);
      }

      // —— 交互 ——
      back.addEventListener('click', () => hangup('back'));
      mainBtn.addEventListener('click', () => {
        if (!machine || machine.state === 'idle' || machine.state === 'ended') {
          startCall();
          return;
        }
        hangup('user');
      });
      muteBtn.addEventListener('click', () => {
        if (!machine) return;
        machine.toggleMute();
        const on = machine.snapshot().muted;
        if (on) {
          // 静音时把正在录的这一段收掉：继续说下去也不该被送去识别。
          endCapture('mute');
        }
      });
      spkBtn.addEventListener('click', () => {
        const prefs = readCallPrefs();
        const next = !prefs.handsFree;
        writeCallPrefs({ handsFree: next });
        spkBtn.classList.toggle('is-on', next);
        spkLabel.textContent = next ? T.speaker : T.speakerOff;
      });
      // 点舞台 = 说完了（没有电平信号时这是唯一的手动收尾）；说话中点 = 打断她。
      stage.addEventListener('click', () => {
        if (!machine) return;
        if (machine.state === 'speaking') {
          cutSpeech();
          machine.level(1, 999); // 越过阈值，让状态机走同一条打断路径
          return;
        }
        if (machine.state === 'listening' && capturing) endCapture('tap');
      });

      const prefs0 = readCallPrefs();
      spkBtn.classList.toggle('is-on', !!prefs0.handsFree);
      spkLabel.textContent = prefs0.handsFree ? T.speaker : T.speakerOff;
      paintLive(false);
      paintMute();
      el.dataset.state = 'idle';

      return {
        // 从别的页面 pop 回来时（比如去设置改了连续通话），把偏好重新读一遍：
        // 机器已经建过就不重建，只同步 continuous，免得把进行中的通话掐断。
        resume() {
          if (!machine) return;
          const prefs = readCallPrefs();
          machine.setContinuous(prefs.continuous);
          spkBtn.classList.toggle('is-on', !!prefs.handsFree);
          spkLabel.textContent = prefs.handsFree ? T.speaker : T.speakerOff;
        },
        destroy() {
          clearTimeout(noteTimer);
          hangup('destroy');
          clearTimeout(kickTimer);
          capturing = false;
          clearTimeout(captureTimer);
          clearInterval(tickTimer);
          clearInterval(clockTimer);
          cutSpeech();
          try {
            recorder.cancel().catch(() => {});
          } catch (_) {
            /* 原生没实现就跳过 */
          }
        },
      };
    },
  };
}
