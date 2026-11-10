// 写信给她 / 意见反馈（全屏页，M7 · D12）。
//
// 版式跟手记详情、聊天历史同一套（eyebrow + 标题 + 副标题 + 内容 + 主按钮），
// 因为这页也是「从别处点进来的一次性动作」，不是常驻页面。
//
// 两条出路：有邮件 App → 拉起邮件 App（信预填好）；没有 → 复制到剪贴板。
// 走哪条由 native 决定，这一页只负责把结果如实说出来，不假装寄出去了。
import { s } from '../../../strings.zh.js';
import { KINDS, MAX_BODY, info as feedbackInfo, send as sendFeedback, copy as copyFeedback } from '../../../core/feedback.js';
import './feedback.css';

export function createFeedbackView() {
  return {
    mount(el) {
      el.classList.add('el-scroll-page', 'el-feedback-page');

      const eyebrow = document.createElement('div');
      eyebrow.className = 'el-eyebrow';
      eyebrow.textContent = s('feedback.eyebrow');

      const title = document.createElement('h1');
      title.className = 'el-page-title';
      title.textContent = s('feedback.title');

      const sub = document.createElement('p');
      sub.className = 'el-page-subtitle';
      sub.textContent = s('feedback.subtitle');

      // 分类分段
      const kindLabel = document.createElement('div');
      kindLabel.className = 'el-feedback-field-label';
      kindLabel.textContent = s('feedback.kind');

      const kinds = document.createElement('div');
      kinds.className = 'el-feedback-kinds';
      const kindButtons = new Map();
      for (const id of KINDS) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'el-feedback-kind';
        btn.dataset.kind = id;
        btn.textContent = s(`feedback.kind_${id}`);
        kinds.append(btn);
        kindButtons.set(id, btn);
      }

      const bodyLabel = document.createElement('div');
      bodyLabel.className = 'el-feedback-field-label';
      bodyLabel.textContent = s('feedback.body');

      const input = document.createElement('textarea');
      input.className = 'el-feedback-input';
      input.rows = 8;
      input.maxLength = MAX_BODY;
      input.placeholder = s('feedback.placeholder');

      const counter = document.createElement('div');
      counter.className = 'el-feedback-counter';

      const actions = document.createElement('div');
      actions.className = 'el-feedback-actions';
      const sendBtn = document.createElement('button');
      sendBtn.type = 'button';
      sendBtn.className = 'el-primary el-feedback-send';
      sendBtn.textContent = s('feedback.send');
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'el-secondary el-feedback-copy';
      copyBtn.textContent = s('feedback.copy');
      actions.append(sendBtn, copyBtn);

      const note = document.createElement('p');
      note.className = 'el-feedback-note';

      el.append(eyebrow, title, sub, kindLabel, kinds, bodyLabel, input, counter, actions, note);

      let kind = 'app';
      let route = { to: '', hasMailApp: false, version: '' };

      function paintKinds() {
        for (const [id, btn] of kindButtons) {
          btn.classList.toggle('is-active', id === kind);
        }
      }

      function paintCounter() {
        const n = input.value.length;
        counter.textContent = n ? s('feedback.counter').replace('{n}', String(n)) : '';
      }

      function paintNote() {
        const to = route.to || '1520208183@qq.com';
        note.textContent = route.hasMailApp
          ? s('feedback.routeMail').replace('{to}', to)
          : s('feedback.routeCopy');
      }

      function setBusy(busy) {
        sendBtn.disabled = busy;
        copyBtn.disabled = busy;
        sendBtn.textContent = busy ? s('feedback.sending') : s('feedback.send');
      }

      kinds.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-kind]');
        if (!btn) return;
        kind = btn.dataset.kind;
        paintKinds();
      });

      input.addEventListener('input', paintCounter);

      sendBtn.addEventListener('click', async () => {
        const text = input.value.trim();
        if (!text) {
          note.textContent = s('feedback.empty');
          input.focus();
          return;
        }
        setBusy(true);
        try {
          const res = await sendFeedback({ kind, text });
          note.textContent =
            res.via === 'clipboard'
              ? s('feedback.sentClipboard')
              : s('feedback.sentMail');
          if (res.via === 'clipboard') {
            // 复制走了就把输入框留着：用户可能想再改一句重发。
          } else {
            input.value = '';
            paintCounter();
          }
        } catch (err) {
          const code = (err && err.code) || '';
          note.textContent = code === 'FEEDBACK_EMPTY'
            ? s('feedback.empty')
            : `${s('feedback.failed')}${(err && err.message) || ''}`;
        } finally {
          setBusy(false);
        }
      });

      copyBtn.addEventListener('click', async () => {
        const text = input.value.trim();
        if (!text) {
          note.textContent = s('feedback.empty');
          input.focus();
          return;
        }
        setBusy(true);
        try {
          const ok = await copyFeedback(text);
          note.textContent = ok ? s('feedback.copied') : s('feedback.failed');
        } catch (err) {
          note.textContent = `${s('feedback.failed')}${(err && err.message) || ''}`;
        } finally {
          setBusy(false);
        }
      });

      paintKinds();
      paintCounter();
      paintNote();

      feedbackInfo().then((res) => {
        route = res;
        paintNote();
      });

      return {
        resume() {
          paintNote();
        },
        destroy() {},
      };
    },
  };
}
