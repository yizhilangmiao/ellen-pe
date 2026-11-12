// 应用内存状态。视图只读快照，改动一律通过这里的方法并触发订阅。
//
// M4 起消息是真落库的（IndexedDB `ellen-mobile-data-v1`，结构同旧包）：
//   - 内存里保留最近 N 条给视图
//   - 每条消息带 headId，后续修改（流式收尾、失败标记）走 revision 追加
//   - 落库是异步的，界面不等它 —— 写失败只在控制台报，不挡聊天
import { loadModelConfig, isUsable } from './config.js';
import { appendMessage, loadMessages, replaceMessage, currentThreadId, recallMessage as recallInStore } from './store/messages.js';

const MESSAGE_WINDOW = 200;

export function createAppState() {
  let messages = [];
  let busy = false;
  let model = null;
  let config = null;
  let error = null;
  let recall = [];
  let threadId = null;
  let localSeq = 0;
  const listeners = new Set();

  function emit() {
    for (const fn of listeners) {
      try {
        fn();
      } catch (err) {
        console.error('[state] 订阅回调失败', err);
      }
    }
  }

  function textOf(m) {
    return m.role === 'user' ? `我：${m.text}` : m.text;
  }

  /**
   * 每条消息一个写链：append 必须先完成，后面的 revision 才有 headId 可用。
   * 不排队的话「快速失败」（比如 401 几十毫秒就回来）会撞在 append 还没落地时，改动丢掉。
   */
  function enqueue(local, task) {
    const prev = local._chain || Promise.resolve();
    local._chain = prev.then(task).catch((err) => console.error('[state] 写库失败', err));
    return local._chain;
  }

  /** 把消息写进库，成功后回填 headId。 */
  function persist(local) {
    return enqueue(local, async () => {
      const rec = await appendMessage(local);
      local.headId = rec.headId;
      local.value = rec.value;
      local.threadId = rec.threadId;
      local.persisted = true;
    });
  }

  /** 修改已落库的那条（流式收尾 / 失败标记）。 */
  function persistPatch(local) {
    return enqueue(local, async () => {
      if (!local.headId || !local.value) return;
      const value = {
        ...local.value,
        text: local.text,
        status: local.pending ? 'pending' : local.failed ? 'failed' : 'done',
      };
      if (local.failed) value.failed = true;
      else delete value.failed;
      if (local.detail) value.detail = local.detail;
      else delete value.detail;
      // 随机语音条：这一句带不带语音条要落库，不然重启回来条就没了
      if (local.voice) value.voice = true;
      else delete value.voice;
      // 语音消息：audio 是文件指针+波形，speech 是只给模型看的转写。漏了这两个，重启回来语音条就空了
      if (local.audio) value.audio = local.audio;
      else delete value.audio;
      if (local.speech) value.speech = local.speech;
      else delete value.speech;
      // 图片 / 表情 / 引用 / 拆条 / 语气：这几样也得跟着落库，否则重启回来只剩纯文字
      for (const key of ['type', 'quoteOf', 'image', 'tone', 'stickerId']) {
        if (local[key]) value[key] = local[key];
        else if (key !== 'type') delete value[key];
      }
      if (typeof local.segIndex === 'number') value.segIndex = local.segIndex;
      else delete value.segIndex;
      if (typeof local.segCount === 'number') value.segCount = local.segCount;
      else delete value.segCount;
      if (local.recalled) {
        value.recalled = true;
        value.recalledAt = local.recalledAt || Date.now();
      }
      local.value = value;
      await replaceMessage(local.headId, value);
    });
  }

  return {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    async init() {
      config = await loadModelConfig();
      model = isUsable(config) ? config.model : null;
      return this.reload();
    },

    /**
     * 重新从库里读一遍（导入资料包之后要调，否则界面还是导入前的内存状态）。
     * 写链没落地的先等一等，别读到半截。
     */
    async reload() {
      const pending = messages.map((m) => m._chain).filter(Boolean);
      if (pending.length) await Promise.allSettled(pending);
      try {
        threadId = await currentThreadId();
        const list = await loadMessages(threadId, MESSAGE_WINDOW);
        messages = list.map((m) => ({ ...m, persisted: true }));
      } catch (err) {
        console.error('[state] 历史消息读不出来', err);
        messages = [];
      }
      emit();
      return { messageCount: messages.length, threadId };
    },

    getConfig() {
      return config;
    },

    async setConfig(next) {
      config = next;
      model = isUsable(config) ? config.model : null;
      emit();
    },

    getModelName() {
      return model;
    },

    getMessages() {
      return messages;
    },

    getThreadId() {
      return threadId;
    },

    isBusy() {
      return busy;
    },

    getError() {
      return error;
    },

    addMessage(msg) {
      const local = {
        id: `local-${++localSeq}`,
        role: msg.role === 'user' ? 'user' : 'assistant',
        text: msg.text || '',
        pending: !!msg.pending,
        failed: !!msg.failed,
        detail: msg.detail || '',
        createdAt: Date.now(),
      };
      // 语音消息的附加字段必须原样透传：audio 决定气泡画不画波形，speech 决定模型听懂什么
      if (msg.audio) local.audio = msg.audio;
      if (msg.speech) local.speech = msg.speech;
      if (msg.voice) local.voice = true;
      // 图片 / 表情 / 引用 / 拆条 / 语气：进库前必须先挂到 local 上，persistPatch 才带得出去
      if (msg.type) local.type = msg.type;
      if (msg.quoteOf) local.quoteOf = msg.quoteOf;
      if (msg.image) local.image = msg.image;
      if (msg.stickerId) local.stickerId = msg.stickerId;
      if (msg.tone) local.tone = msg.tone;
      if (typeof msg.segIndex === 'number') local.segIndex = msg.segIndex;
      if (typeof msg.segCount === 'number') local.segCount = msg.segCount;
      messages.push(local);
      emit();
      persist(local);
      return local;
    },

    /**
     * 改一条消息。
     * @param {string} id
     * @param {object} patch
     * @param {{persist?: boolean}} [opts] persist=false 只改内存（流式每个 chunk 都落库会把 revision 撑爆）
     */
    updateMessage(id, patch, opts = {}) {
      const target = messages.find((m) => m.id === id);
      if (!target) return;
      Object.assign(target, patch);
      emit();
      if (opts.persist !== false) persistPatch(target);
    },

    /**
     * 撤回一条已落库的消息（2 分钟窗口由调用方判断，这里只负责写）。
     * 只加 recalled 标记，原文留在库里——误删没法找回，删字更狠。
     * @param {string} idOrHead 内存 id 或库里的 headId 都认
     * @returns {Promise<object|null>} 新的 value，找不到返回 null
     */
    recallMessage(idOrHead) {
      const target = messages.find((m) => m.id === idOrHead || m.headId === idOrHead);
      if (!target || !target.headId) return Promise.resolve(null);
      return enqueue(target, async () => {
        const value = await recallInStore(target.headId);
        if (!value) return null;
        target.value = value;
        target.recalled = true;
        target.recalledAt = value.recalledAt || Date.now();
        emit();
        return value;
      });
    },

    clearMessages() {
      messages = [];
      emit();
    },

    setBusy(flag) {
      busy = !!flag;
      emit();
    },

    setError(err) {
      error = err;
      emit();
    },

    setRecall(items) {
      recall = Array.isArray(items) ? items : [];
      emit();
    },

    getRecall() {
      return recall;
    },

    snapshot() {
      return {
        busy,
        model,
        threadId,
        messageCount: messages.length,
        messages: messages.map((m) => ({
          id: m.id,
          role: m.role,
          text: m.text,
          pending: !!m.pending,
          failed: !!m.failed,
          detail: m.detail || '',
          headId: m.headId || null,
          persisted: !!m.persisted,
          // 语音消息：验收要看「气泡里没文字、重启后还在」，没有这两个字段就只能点屏幕
          audio: m.audio || null,
          speech: m.speech || null,
          // 探针要能看到新字段：图片/表情/引用/拆条/撤回全靠它们判定渲染分支
          type: m.type || 'text',
          recalled: !!m.recalled,
          quoteOf: m.quoteOf || null,
          image: m.image || null,
          stickerId: m.stickerId || null,
          tone: m.tone || null,
          segIndex: typeof m.segIndex === 'number' ? m.segIndex : null,
          segCount: typeof m.segCount === 'number' ? m.segCount : null,
        })),
        configUsable: isUsable(config),
        recall: recall.map((r) => ({ kind: r.kind, title: r.title, score: r.score })),
        error: error ? String(error.message || error) : null,
        transcript: messages.map(textOf),
      };
    },
  };
}
