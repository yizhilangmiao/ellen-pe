// 聊天页视图。只做"渲染 + 收集输入"，不认识插件、不发网络请求
// （§6.5 第 1 条：视图单向依赖；验收 grep 本文件出现 fetch(/registerPlugin 必须 0 条）。
// 真正的发送走 props.onSend（由 app 层注入，app 层再交给 core/chat 会话）。
import { s } from '../../../strings.zh.js';
import { iconEl } from '../../icons.js';
import { renderRichText } from '../../richtext.js';
import { speak, stop as stopSpeaking, plain } from '../../../core/speech.js';
import './chat.css';

export function createChatView() {
  return {
    mount(el, props = {}) {
      const state = {
        messages: props.messages ? props.messages.slice() : [],
        model: props.model || null,
        busy: false,
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

      // 语音输入：按住说话（点一下开始、再点一下结束），转成文字填进输入框由用户自己发
      const micBtn = document.createElement('button');
      micBtn.type = 'button';
      micBtn.className = 'el-composer-mic';
      micBtn.append(iconEl('mic'));
      micBtn.setAttribute('aria-label', s('chat.voice'));
      micBtn.setAttribute('aria-pressed', 'false');

      const stopBtn = document.createElement('button');
      stopBtn.type = 'button';
      stopBtn.className = 'el-composer-stop';
      stopBtn.append(iconEl('stop'));
      stopBtn.setAttribute('aria-label', s('chat.stop'));
      stopBtn.hidden = true;

      composer.append(micBtn, field, stopBtn, sendBtn);
      el.append(stream, composer);

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

      function renderMessage(msg) {
        const node = document.createElement('div');
        node.className = 'el-msg';
        node.dataset.role = msg.role === 'user' ? 'user' : 'assistant';
        if (msg.pending) node.dataset.pending = '1';
        if (msg.failed) node.dataset.failed = '1';
        const body = document.createElement('div');
        body.className = 'el-msg-body';
        body.innerHTML = renderRichText(msg.text);
        node.append(body);
        // 只有她说的话带朗读按钮（自己说的话自己知道）
        if (msg.role !== 'user' && !msg.pending && !msg.failed && String(msg.text || '').trim()) {
          node.append(speakButton(msg, node));
        }
        if (msg.detail) {
          const d = document.createElement('div');
          d.className = 'el-msg-detail';
          d.textContent = msg.detail;
          node.append(d);
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
        if (body) body.innerHTML = renderRichText(last.text);
        if (last.pending) node.dataset.pending = '1';
        else delete node.dataset.pending;
        if (last.failed) node.dataset.failed = '1';
        else delete node.dataset.failed;
        let d = node.querySelector('.el-msg-detail');
        if (last.detail) {
          if (!d) {
            d = document.createElement('div');
            d.className = 'el-msg-detail';
            node.append(d);
          }
          d.textContent = last.detail;
        } else if (d) {
          d.remove();
        }
      }

      function render() {
        stream.innerHTML = '';
        if (!state.messages.length) {
          stream.append(renderEmpty());
          return;
        }
        for (const msg of state.messages) stream.append(renderMessage(msg));
        stream.scrollTop = stream.scrollHeight;
      }

      function syncBusy() {
        sendBtn.hidden = state.busy;
        stopBtn.hidden = !state.busy;
        sendBtn.disabled = state.busy || !field.value.trim();
      }

      function autosize() {
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
      // 按住说话：pointerdown 开录、松手收尾。
      // click 只在没有 pointer 事件的环境（键盘/无障碍）兜底，手机上按一次不会触发两回。
      let pointerHeld = false;
      micBtn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        pointerHeld = true;
        try {
          micBtn.setPointerCapture(e.pointerId);
        } catch (err) {
          /* 老 WebView 没有 capture，忽略 */
        }
        if (props.onMic) props.onMic('start');
      });
      const releaseMic = () => {
        if (!pointerHeld) return;
        pointerHeld = false;
        if (props.onMic) props.onMic('stop');
      };
      micBtn.addEventListener('pointerup', releaseMic);
      micBtn.addEventListener('pointercancel', releaseMic);
      micBtn.addEventListener('lostpointercapture', releaseMic);
      micBtn.addEventListener('click', () => {
        if (pointerHeld) return;
        if (props.onMic) props.onMic('toggle');
      });

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

      return {
        setRecording,
        setDictation,
        destroy() {},
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
          const node = renderMessage(msg);
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
    },
  };
}
