// 聊天页视图。只做"渲染 + 收集输入"，不认识插件、不发网络请求
// （§6.5 第 1 条：视图单向依赖；验收 grep 本文件出现 fetch(/registerPlugin 必须 0 条）。
// 真正的发送走 props.onSend（由 app 层注入，app 层再交给 core/chat 会话）。
import { s } from '../../../strings.zh.js';
import { iconEl } from '../../icons.js';
import { renderRichText } from '../../richtext.js';
import { speak, stop as stopSpeaking, plain, synthesizeUrl } from '../../../core/speech.js';
import { readDocument, toBlobUrl, revokeAll } from '../../../core/documents.js';
import './chat.css';

// 语音态文案。lead 在改 strings.zh.js，这里先用本地常量，别两头改同一个文件。
// 文案统一走 strings.zh.js 的 chat 段（getter：切换语言时立刻生效，不必重建视图）
// arming 超过这个时长还没进 recording，就是卡在系统权限弹窗上了
const ARMING_WAIT_MS = 600;

const VT = {
  get hold() { return s('chat.voiceHold'); },
  get arming() { return s('chat.voiceArming'); },
  get slideCancel() { return s('chat.voiceSlideCancel'); },
  get releaseSend() { return s('chat.voiceReleaseSend'); },
  get releaseCancel() { return s('chat.voiceReleaseCancel'); },
  get writing() { return s('chat.voiceWriting'); },
  get tooShort() { return s('chat.voiceTooShort'); },
  get keyboard() { return s('chat.voiceKeyboard'); },
  get missing() { return s('chat.voiceMissing'); },
  get asrFailed() { return s('chat.voiceAsrFailed'); },
};

export function createChatView() {
  return {
    mount(el, props = {}) {
      const state = {
        messages: props.messages ? props.messages.slice() : [],
        model: props.model || null,
        busy: false,
        // 输入条两态：text（文本框） / voice（按住说话）
        mode: 'text',
      };

      el.classList.add('el-chat-page');
      el.innerHTML = '';

      const stream = document.createElement('div');
      stream.className = 'el-chat-stream';

      const composer = document.createElement('div');
      composer.className = 'el-chat-composer';

      const field = document.createElement('textarea');
      field.className = 'el-composer-field';
      field.rows = 1;
      field.placeholder = s('chat.placeholder');
      field.setAttribute('aria-label', s('chat.placeholder'));

      const sendBtn = document.createElement('button');
      sendBtn.type = 'button';
      sendBtn.className = 'el-composer-send';
      sendBtn.append(iconEl('send'));
      sendBtn.setAttribute('aria-label', s('chat.send'));
      sendBtn.disabled = true;

      // 麦克风：现在只负责「切到语音态」（微信式），不再点一下开录、再点一下结束。
      const micBtn = document.createElement('button');
      micBtn.type = 'button';
      micBtn.className = 'el-composer-mic';
      micBtn.append(iconEl('mic'));
      micBtn.setAttribute('aria-label', s('chat.voice'));
      micBtn.setAttribute('aria-pressed', 'false');

      // 语音态左边那个「键盘」：切回文字。icons.js 里没有 keyboard，这里照同一套属性手写一个
      const keyboardBtn = document.createElement('button');
      keyboardBtn.type = 'button';
      keyboardBtn.className = 'el-composer-keyboard';
      const kbIcon = document.createElement('span');
      kbIcon.className = 'el-icon';
      kbIcon.setAttribute('aria-hidden', 'true');
      kbIcon.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
        'stroke-linecap="round" stroke-linejoin="round">' +
        '<rect x="2.5" y="6" width="19" height="12" rx="3"></rect>' +
        '<path d="M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M6.5 14h.01M17 14h.01M9.5 14h5"></path>' +
        '</svg>';
      keyboardBtn.append(kbIcon);
      keyboardBtn.setAttribute('aria-label', VT.keyboard);
      keyboardBtn.hidden = true;

      // 按住说话。高 36u，按下变暗；上滑进取消态。
      const holdBtn = document.createElement('button');
      holdBtn.type = 'button';
      holdBtn.className = 'el-composer-hold';
      holdBtn.textContent = VT.hold;
      holdBtn.setAttribute('aria-label', s('chat.voiceHoldAria'));
      holdBtn.hidden = true;

      const stopBtn = document.createElement('button');
      stopBtn.type = 'button';
      stopBtn.className = 'el-composer-stop';
      stopBtn.append(iconEl('stop'));
      stopBtn.setAttribute('aria-label', s('chat.stop'));
      stopBtn.hidden = true;

      composer.append(micBtn, keyboardBtn, field, holdBtn, stopBtn, sendBtn);

      // 系统条：技术性失败（HTTP 404 / 钥匙不对）只在这里出现一行，不塞进她的气泡里。
      // 评审原话「404 进系统条」：错误不是她说的话，长得像气泡就会让人以为是她在推卸。
      const systemStrip = document.createElement('button');
      systemStrip.type = 'button';
      systemStrip.className = 'el-system-strip';
      systemStrip.hidden = true;
      systemStrip.addEventListener('click', () => {
        dismissedAt = state.messages.length;
        paintSystemStrip();
      });

      // 录音浮层：贴在输入条上方（position:fixed），四个 class 由 setVoiceState 驱动：
      // is-recording / is-cancelling / is-writing / is-error。不写内联 style，波形高度走 nth-child。
      const hud = document.createElement('div');
      hud.className = 'el-voice-hud';
      hud.hidden = true;
      hud.setAttribute('role', 'status');
      hud.setAttribute('aria-live', 'polite');

      const hudWave = document.createElement('span');
      hudWave.className = 'el-voice-hud-wave';
      for (let i = 0; i < 12; i += 1) hudWave.append(document.createElement('i'));

      const hudTimer = document.createElement('span');
      hudTimer.className = 'el-voice-hud-time';
      hudTimer.textContent = '0:00';

      const hudHint = document.createElement('span');
      hudHint.className = 'el-voice-hud-hint';
      hudHint.textContent = VT.slideCancel;

      hud.append(hudWave, hudTimer, hudHint);

      el.append(stream, systemStrip, composer, hud);

      let dismissedAt = -1;

      /** 找最后一条带 detail 的失败消息，把它挂到系统条上；点一下算「知道了」。 */
      function paintSystemStrip() {
        const msgs = state.messages || [];
        let idx = -1;
        // 只看最后两条：历史里的旧失败不该每次开 App 都挂一条在顶上。
        for (let i = msgs.length - 1; i >= Math.max(0, msgs.length - 2); i -= 1) {
          if (msgs[i] && msgs[i].detail) { idx = i; break; }
        }
        if (idx < 0 || idx <= dismissedAt) {
          systemStrip.hidden = true;
          systemStrip.textContent = '';
          return;
        }
        systemStrip.hidden = false;
        systemStrip.textContent = String(msgs[idx].detail);
      }

      function fmtMs(v) {
        const total = Math.max(0, Math.round((Number(v) || 0) / 1000));
        return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
      }

      let voiceErrorTimer = null;

      /** 录音浮层只认这一个入口：控制器的 onState 直接调它，视图不自己猜状态。 */
      function setVoiceState(st) {
        const phase = (st && st.phase) || 'idle';
        const cancel = !!(st && st.cancel);
        // arming 只是「手指按下了，还在等录音器就绪」，不算在录：
        // 权限被拒、录音器起不来的时候，点亮 is-recording 会骗人。
        const arming = phase === 'arming';
        const active = phase === 'recording' || phase === 'cancelling';
        if (voiceErrorTimer) {
          clearTimeout(voiceErrorTimer);
          voiceErrorTimer = null;
          hud.classList.remove('is-error');
        }
        hud.hidden = !arming && !active && phase !== 'transcribing';
        hud.classList.toggle('is-arming', arming);
        hud.classList.toggle('is-recording', active);
        hud.classList.toggle('is-cancelling', cancel && active);
        hud.classList.toggle('is-writing', phase === 'transcribing');
        holdBtn.classList.toggle('is-pressed', arming || active);
        holdBtn.classList.toggle('is-cancel', cancel && active);
        hudTimer.textContent = fmtMs(st && st.ms);
        if (phase === 'transcribing') hudHint.textContent = VT.writing;
        else if (cancel) hudHint.textContent = VT.releaseCancel;
        else if (phase === 'recording') hudHint.textContent = VT.releaseSend;
        else if (arming) hudHint.textContent = (Number(st && st.ms) || 0) > ARMING_WAIT_MS ? s('chat.voiceArmingWait') : VT.arming;
        else hudHint.textContent = VT.slideCancel;
      }

      /** 错误码 → 一行人话，浮层变红 1.4 s 后自己收起（别卡在「在听写…」）。 */
      function setVoiceError(err) {
        const code = (err && err.code) || '';
        const text =
          code === 'VOICE_TOO_SHORT'
            ? VT.tooShort
            : code === 'AUDIO_PERMISSION'
              ? s('chat.voiceNeedPermission')
              : code === 'AUDIO_BUSY'
                ? s('chat.voiceBusy')
                : code === 'ASR_NOT_CONFIGURED'
                  ? s('chat.voiceNeedConfig')
                  : code === 'ASR_NETWORK'
                    ? s('chat.voiceNetFail')
                    : `${s('chat.voiceFailed')}${String((err && err.message) || code).slice(0, 40)}`;
        hud.hidden = false;
        hud.classList.remove('is-recording', 'is-cancelling', 'is-writing', 'is-arming');
        hud.classList.add('is-error');
        hudHint.textContent = text;
        hudTimer.textContent = '';
        if (voiceErrorTimer) clearTimeout(voiceErrorTimer);
        voiceErrorTimer = setTimeout(() => {
          voiceErrorTimer = null;
          hud.classList.remove('is-error');
          hud.hidden = true;
        }, 1400);
      }

      /** 两态切换。用户点的（notify=true）要告诉 app 层，初始化时不通知。 */
      function setMode(next, notify = true) {
        const mode = next === 'voice' ? 'voice' : 'text';
        state.mode = mode;
        const voice = mode === 'voice';
        composer.classList.toggle('is-voice', voice);
        micBtn.hidden = voice;
        keyboardBtn.hidden = !voice;
        field.hidden = voice;
        holdBtn.hidden = !voice;
        if (voice) {
          field.blur();
        } else {
          // 从语音态切回键盘：还在录的那条直接作废，别留半段录音在后台
          holdPointer = null;
          if (props.voice) props.voice.cancel();
          hud.hidden = true;
          field.focus();
        }
        syncBusy();
        if (notify && props.onVoiceMode) props.onVoiceMode(mode);
      }

      function renderEmpty() {
        const wrap = document.createElement('div');
        wrap.className = 'el-chat-empty';

        const title = document.createElement('h2');
        title.className = 'el-chat-empty-title';
        title.textContent = s('chat.emptyTitle');

        const hint = document.createElement('p');
        hint.className = 'el-chat-empty-hint';
        hint.textContent = state.model ? s('chat.emptyHintReady') : s('chat.emptyHint');

        const actions = document.createElement('div');
        actions.className = 'el-chat-empty-actions';

        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'el-chat-model-chip';
        if (state.model) {
          chip.textContent = state.model;
        } else {
          chip.classList.add('is-unset');
          chip.textContent = s('chat.noModel');
          chip.addEventListener('click', () => props.onRequestModel && props.onRequestModel());
        }

        const thinking = document.createElement('span');
        thinking.className = 'el-chat-thinking-chip';
        thinking.textContent = s('chat.thinkingChip');

        actions.append(chip, thinking);
        wrap.append(title, hint, actions);
        return wrap;
      }

      // 正在念的那条气泡。点同一个再点一次 = 停下来。
      let speakingNode = null;

      function speakButton(msg, node) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'el-msg-speak';
        btn.setAttribute('aria-label', '念出来');
        btn.append(iconEl('volume'));
        btn.addEventListener('click', async () => {
          const same = speakingNode === node;
          if (speakingNode) {
            speakingNode.classList.remove('is-speaking');
            speakingNode = null;
          }
          await stopSpeaking().catch(() => {});
          if (same) return;
          const body = plain(msg.text);
          if (!body) return;
          node.classList.add('is-speaking');
          speakingNode = node;
          const res = await speak(body).catch((err) => ({ error: String(err) }));
          if (res && (res.error || res.speaking === false)) {
            node.classList.remove('is-speaking');
            if (speakingNode === node) speakingNode = null;
          }
        });
        return btn;
      }


      // —— 波形条 ——
      // 她发的随机语音条、自己发出去的语音消息共用这一套（waveBar）。
      // peaks 是 0-100 的整数数组，高度只给 6 档 class：视图层不许写内联 style。
      const clipCache = new Map();
      const voiceCache = new Map();

      function levelOf(v) {
        const n = Math.max(0, Math.min(100, Number(v) || 0));
        if (n < 12) return 1;
        if (n < 30) return 2;
        if (n < 50) return 3;
        if (n < 68) return 4;
        if (n < 86) return 5;
        return 6;
      }

      /**
       * @param {{peaks?: number[], durationMs: number, label?: string, className?: string,
       *          bars?: number, onPlay?: () => Promise<string>}} opts
       * onPlay 返回可播的 blob URL；返回空串/抛错 = 这一条播不出来（条变红，不崩）。
       */
      function waveBar(opts = {}) {
        const bar = document.createElement('button');
        bar.type = 'button';
        bar.className = `el-msg-clip ${opts.className || ''}`.trim();
        if (opts.label) bar.setAttribute('aria-label', opts.label);
        const dot = document.createElement('span');
        dot.className = 'el-msg-clip-dot';
        const wave = document.createElement('span');
        wave.className = 'el-msg-clip-wave';
        const bars = Math.max(1, Math.min(24, opts.bars || 12));
        const peaks = Array.isArray(opts.peaks) && opts.peaks.length ? opts.peaks : [];
        for (let i = 0; i < bars; i += 1) {
          const tick = document.createElement('i');
          const at = peaks.length ? peaks[Math.floor((i / bars) * peaks.length)] : 0;
          if (peaks.length) tick.className = `lv${levelOf(at)}`;
          wave.append(tick);
        }
        const len = document.createElement('span');
        len.className = 'el-msg-clip-len';
        len.textContent = `${Math.max(1, Math.round((Number(opts.durationMs) || 0) / 1000))}″`;

        let audio = null;
        bar.addEventListener('click', async () => {
          if (bar.disabled) return;
          if (audio && !audio.paused) {
            audio.pause();
            bar.classList.remove('is-playing');
            return;
          }
          if (!opts.onPlay) return;
          bar.classList.remove('is-failed');
          bar.classList.add('is-loading');
          let url = '';
          try {
            url = await opts.onPlay();
          } catch (err) {
            url = '';
          }
          bar.classList.remove('is-loading');
          if (!url) {
            bar.classList.add('is-failed');
            return;
          }
          audio = new Audio(url);
          audio.addEventListener('ended', () => bar.classList.remove('is-playing'));
          bar.classList.add('is-playing');
          audio.play().catch(() => bar.classList.remove('is-playing'));
        });

        bar.append(dot, wave, len);
        return bar;
      }

      // 她的随机语音条：点一下才合成播放（合成要花 minimax 的钱，没人点就别花）。
      function clipBar(msg, node) {
        // 失败时贴在气泡里的一行人话：下一次点击自动消失。
        // 没有它的话，重试虽然真的在跑（synthesize 会被再调一次），但界面上什么都没变，
        // 用户看到的就是「点了没反应」，只能杀进程重进。
        const note = document.createElement('span');
        note.className = 'el-msg-clip-note';
        note.hidden = true;
        const clearFail = () => {
          node.classList.remove('is-clip-failed');
          note.hidden = true;
          note.textContent = '';
        };
        const chars = plain(msg.text).length;

        const bar = waveBar({
          durationMs: Math.max(2, Math.round(chars / 5)) * 1000,
          label: '语音条',
          onPlay: async () => {
            // 一按下去就把上一次的失败痕迹摘干净，加载态才看得见
            clearFail();
            const hit = clipCache.get(msg.id);
            if (hit) return hit;
            const res = await synthesizeUrl(msg.text).catch((err) => ({
              error: String((err && err.message) || err),
              code: (err && err.code) || '',
            }));
            if (!res || res.error) {
              node.classList.add('is-clip-failed');
              note.textContent =
                res && res.code === 'NO_API_KEY'
                  ? '还没配朗读的 key，去设置 → 声音里填一下'
                  : '这条念不出来，等下再点一次';
              // 文案挂在条下面（当条的小字注释），不是条上面——否则读起来像正文的一部分
              if (!note.isConnected) node.insertBefore(note, bar.nextSibling);
              note.hidden = false;
              return '';
            }
            clipCache.set(msg.id, res.url);
            return res.url;
          },
        });
        return bar;
      }

      // 自己发出去的语音消息：气泡里只有波形 + 时长，文字只挂 aria-label。
      // 播放要先把附件读回 base64 再转 blob URL（WebView 不能直接播 content://）。
      function voiceBubble(msg) {
        const audio = msg.audio || {};
        const missing = !!audio.missing;
        const asrFailed = !!(msg.speech && msg.speech.failed);
        const classes = ['el-msg-voice'];
        if (missing) classes.push('is-missing');
        if (asrFailed) classes.push('is-asr-failed');
        if (audio.preparing) classes.push('is-preparing');

        const bar = waveBar({
          peaks: audio.peaks,
          durationMs: audio.durationMs,
          bars: 14,
          label: String(msg.text || s('chat.voiceMessageLabel')),
          className: classes.join(' '),
          onPlay: missing
            ? null
            : async () => {
                const key = String(audio.uri || audio.name || msg.id);
                const hit = voiceCache.get(key);
                if (hit) return hit;
                const res = await readDocument(audio.uri || audio.name).catch(() => null);
                if (!res || !res.base64) return '';
                const url = toBlobUrl(res.base64, res.mimeType || 'audio/wav', `voice:${key}`);
                voiceCache.set(key, url);
                return url;
              },
        });
        if (missing) {
          bar.disabled = true;
          bar.setAttribute('aria-disabled', 'true');
          bar.setAttribute('title', VT.missing);
        }
        return bar;
      }

      function renderMessage(msg, enter) {
        const node = document.createElement('div');
        node.className = 'el-msg';
        if (enter) node.classList.add('zz-anim-pop');
        node.dataset.role = msg.role === 'user' ? 'user' : 'assistant';
        if (msg.pending) node.dataset.pending = '1';
        if (msg.failed) node.dataset.failed = '1';

        const body = document.createElement('div');
        body.className = 'el-msg-body';
        // 语音消息：气泡里只有波形，一个字都不渲染（text 走 aria-label，复制/搜索仍拿得到）
        if (msg.audio) {
          node.classList.add('el-msg-has-voice');
          body.hidden = true;
          node.append(voiceBubble(msg), body);
        } else {
          body.innerHTML = renderRichText(msg.text);
          node.append(body);
        }
        // 只有她说的话带朗读按钮（自己说的话自己知道）
        if (msg.role !== 'user' && !msg.pending && !msg.failed && String(msg.text || '').trim()) {
          if (msg.voice) node.append(clipBar(msg, node));
          node.append(speakButton(msg, node));
        }
        return node;
      }

      /** 只更新最后一条气泡，不做整页重排（流式时每块都走这里）。 */
      function patchLast(patch) {
        const last = state.messages[state.messages.length - 1];
        if (!last) return;
        Object.assign(last, patch);
        const nodes = stream.querySelectorAll('.el-msg');
        const node = nodes[nodes.length - 1];
        if (!node) return;
        const body = node.querySelector('.el-msg-body');
        if (body) {
          // 语音消息不渲染文字：只在收尾补 patch 时把 body 藏起来（气泡里的波形节点已经在了）
          if (last.audio) {
            node.classList.add('el-msg-has-voice');
            body.hidden = true;
          } else {
            body.hidden = false;
            body.innerHTML = renderRichText(last.text);
          }
        }
        if (last.pending) node.dataset.pending = '1';
        else delete node.dataset.pending;
        if (last.failed) node.dataset.failed = '1';
        else delete node.dataset.failed;
        paintSystemStrip();
      }

      let painted = false;

      function render() {
        stream.innerHTML = '';
        if (!state.messages.length) {
          stream.append(renderEmpty());
          return;
        }
        // 只有「新到的最后两条」播入场；历史不重播（否则每次切页都像下暴雨）
        const last = state.messages.length - 1;
        state.messages.forEach((msg, i) => {
          stream.append(renderMessage(msg, painted && i >= last - 1));
        });
        painted = true;
        paintSystemStrip();
        stream.scrollTop = stream.scrollHeight;
      }

      function syncBusy() {
        const voice = state.mode === 'voice';
        sendBtn.hidden = state.busy || voice;
        stopBtn.hidden = !state.busy;
        sendBtn.disabled = state.busy || voice || !field.value.trim();
        // 她在说话的时候不许开新录音：一次只跑一条
        holdBtn.disabled = state.busy;
      }

      function autosize() {
        // 语音态下输入框是隐藏的，scrollHeight 读出来是 0，会把高度写成一行
        if (field.hidden) return;
        field.style.height = 'auto';
        field.style.height = `${Math.min(field.scrollHeight, 126 * 0.2315 * 0.5 + 60)}px`;
      }

      function submit() {
        const text = field.value.trim();
        if (!text || state.busy) return;
        field.value = '';
        autosize();
        syncBusy();
        if (props.onSend) props.onSend(text);
      }

      field.addEventListener('input', () => {
        autosize();
        syncBusy();
      });
      field.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          submit();
        }
      });
      // 按住说话：pointerdown 开录、上滑取消、松手收尾。
      // 状态机（300ms 起录、700ms 下限、48px 取消、60s 上限）全在 core/voice-input.js，
      // 这里只负责把坐标搬过去，不做任何判定。
      const voice = props.voice || (window.__ellenChatDebug && window.__ellenChatVoice) || null;
      let holdPointer = null;
      holdBtn.addEventListener('pointerdown', (e) => {
        if (!voice || state.busy || holdPointer !== null) return;
        e.preventDefault();
        holdPointer = e.pointerId;
        try {
          holdBtn.setPointerCapture(e.pointerId);
        } catch (err) {
          /* 老 WebView 没有 capture，靠 pointerup 兜底 */
        }
        voice.press(e.clientX, e.clientY);
      });
      holdBtn.addEventListener('pointermove', (e) => {
        if (!voice || e.pointerId !== holdPointer) return;
        voice.move(e.clientX, e.clientY);
      });
      const endHold = (e, cancelled) => {
        if (!voice || e.pointerId !== holdPointer) return;
        holdPointer = null;
        if (cancelled) voice.cancel();
        else voice.release();
      };
      holdBtn.addEventListener('pointerup', (e) => endHold(e, false));
      holdBtn.addEventListener('pointercancel', (e) => endHold(e, true));
      holdBtn.addEventListener('lostpointercapture', (e) => endHold(e, true));
      holdBtn.addEventListener('contextmenu', (e) => e.preventDefault());
      // 键盘兜底：没有 pointer 事件的环境（无障碍开关/外接键盘）按一下就能录，
      // 再按一下收尾——状态机自己会处理 arming 阶段的误触。
      holdBtn.addEventListener('keydown', (e) => {
        if (!voice || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        if (holdPointer === null) {
          holdPointer = 'key';
          voice.press(0, 0);
        } else {
          holdPointer = null;
          voice.release();
        }
      });
      micBtn.addEventListener('click', () => setMode('voice'));
      keyboardBtn.addEventListener('click', () => setMode('text'));

      function setRecording(on) {
        micBtn.classList.toggle('is-recording', !!on);
        micBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
        field.placeholder = on ? s('chat.voiceRecording') : s('chat.placeholder');
      }

      function setDictation(text) {
        field.value = text || '';
        field.dispatchEvent(new Event('input'));
        field.focus();
      }

      sendBtn.addEventListener('click', submit);
      stopBtn.addEventListener('click', () => props.onStop && props.onStop());

      render();
      syncBusy();
      setMode('text', false);
      // 控制器每次状态变化都会喊一声；主入口是 props.voice 的 onState，这里只是
      // 多一条订阅通道（老版本 main.js 还没接 onState 时不至于完全没有反馈）。
      if (voice && typeof voice.subscribe === 'function') {
        voice.subscribe((st) => {
          // 控制器把失败也顺着 state 广播一份（st.error）：权限被拒、录音器起不来
          // 的时候浮层要变红说话，否则界面一声不吭，看着像按钮坏了。
          if (st && st.error) setVoiceError(st.error);
          else if (st && st.phase === 'error') setVoiceError(st);
          else setVoiceState(st);
        });
      }

      // 页面切走 / Activity 暂停时把正在录的那段收掉：
      // 手指滑出元素还能补 lostpointercapture，人按 Home 键就没 pointerup 可等了。
      const onHidden = () => {
        if (document.visibilityState !== 'hidden' || !voice) return;
        const st = typeof voice.state === 'function' ? voice.state() : null;
        if (st && st.phase !== 'idle' && st.phase !== 'transcribing') voice.cancel();
      };
      document.addEventListener('visibilitychange', onHidden);

      const api = {
        setVoiceState,
        setVoiceError,
        setMode,
        setRecording,
        setDictation,
        // 语音条 / 语音消息的 blob URL 只在当前这棵 stream 上还有用；视图销毁就全撤掉。
        // 不撤的话 1/7 概率攒下来的 blob 会一直常驻（聊 700 句就是 100 个 URL）。
        destroy() {
          document.removeEventListener('visibilitychange', onHidden);
          clipCache.forEach((url) => {
            try {
              URL.revokeObjectURL(url);
            } catch (err) {
              /* 已经释放过就忽略 */
            }
          });
          clipCache.clear();
          voiceCache.clear();
          revokeAll();
        },
        // 供 app 层推送状态
        setMessages(list) {
          const prev = state.messages;
          const sameCount = prev.length === list.length;
          const samePrefix =
            sameCount &&
            list.length > 0 &&
            prev.slice(0, -1).every((m, i) => m.id === list[i].id && m.text === list[i].text);
          state.messages = list.slice();
          // 只有最后一条在变（流式）时走增量，避免整页重绘闪一下
          if (samePrefix) {
            patchLast({});
            stream.scrollTop = stream.scrollHeight;
            return;
          }
          render();
        },
        appendMessage(msg) {
          state.messages.push(msg);
          const node = renderMessage(msg, true);
          const empty = stream.querySelector('.el-chat-empty');
          if (empty) empty.remove();
          stream.append(node);
          stream.scrollTop = stream.scrollHeight;
          return node;
        },
        updateLast(patch) {
          patchLast(patch);
          stream.scrollTop = stream.scrollHeight;
        },
        setModel(name) {
          state.model = name;
          render();
        },
        setBusy(flag) {
          state.busy = !!flag;
          syncBusy();
        },
        focus() {
          field.focus();
        },
      };
      // 验收临时探针：页面显式置 window.__ellenChatDebug 才暴露（验完删）
      if (window.__ellenChatDebug) window.__chatApi = api;
      return api;
    },
  };
}
