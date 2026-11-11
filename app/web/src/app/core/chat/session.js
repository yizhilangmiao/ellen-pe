// 聊天会话：把"一条用户消息"变成"一条艾莲回复"。
//
// 数据通路是两段式流：
//   EllenModelHttp.open(requestId, url, apiKey, body) → 拿到 HTTP 状态
//   EllenModelHttp.read(requestId, sequence)          → 分块拿 base64，sequence 从 1 开始递增到 done
//   EllenModelHttp.cancel(requestId)                  → 中途停
// 服务地址来自配置（原生已放开成任意 https 的 OpenAI 兼容端点），
// 所以换平台只改配置，不动代码。
import { call, requestId as newRequestId } from '../native/bridge.js';
import { isUsable, platformOf } from '../config.js';
import { recall, renderRecall } from './recall.js';
import { keepAlive } from '../background.js';
import { readChatPrefs } from '../chatprefs.js';

// 单块密文上限：native 每次最多给 0x4000 原始字节（21848 个 base64 字符），
// 这里只是给个防御性上限，正常永远碰不到。
const MAX_CHUNKS = 4096;

/**
 * 把 HTTP 失败翻译成人话。
 *
 * 服务端的错误体长这样：
 *   {"error":{"code":"AuthenticationError","message":"The API key format is incorrect. …","type":"Unauthorized"}}
 * 整段糊在气泡里没法看（旧实现就是这样），所以这里解析出 code/message，
 * 挑一句中文主文案，原文放进 detail 让小字显示。
 */
export function explainFailure(status, rawBody) {
  let code = '';
  let message = '';
  try {
    const j = JSON.parse(rawBody);
    const e = (j && j.error) || j || {};
    code = String(e.code || e.type || '');
    message = String(e.message || '');
  } catch {
    // 非 JSON（比如网关返回 HTML）就只留原文
  }

  const both = `${code} ${message}`;
  const lower = both.toLowerCase();

  if (status === 401 || status === 403) {
    if (lower.includes('format is incorrect') || lower.includes('invalid api key format')) {
      return {
        text: '这个 key 的格式不对。检查一下是不是复制少了字符，或者把别家的 key 填进来了。',
        code,
      };
    }
    if (lower.includes("doesn't exist") || lower.includes('not exist') || lower.includes('invalid api key')) {
      return { text: '这个 key 不存在，可能已经删掉了。回平台后台重新建一枚再填。', code };
    }
    return { text: 'key 不对，或者这枚 key 没有该模型的权限。', code };
  }
  if (status === 402 || lower.includes('insufficient') || lower.includes('quota')) {
    return { text: '账户余额不足，去平台充一点再试。', code };
  }
  if (status === 404) {
    return { text: '地址或模型名不对。检查设置里的服务地址和模型名，两边要跟平台一致。', code };
  }
  if (status === 429) {
    return { text: '请求太快或者额度用完了，缓一下再发。', code };
  }
  if (status >= 500) {
    return { text: '服务平台自己出错了（不是你的配置问题），过一会儿再试。', code };
  }
  // 兜底：模型名不对这类 400 服务端会回一长串英文（还带 request_id），
  // 原文只该进系统条，不该糊在她的话里。这里只给一句能干点什么的话。
  if (status === 400) {
    return { text: '这次请求被服务端退了。多半是模型名不对——回设置里挑一个平台推荐的模型再试。', code };
  }
  if (message) {
    return { text: '服务端说这次请求不行，具体原因在下面那行。', code };
  }
  return { text: `服务端返回 ${status}，这次没成。`, code };
}

// getSystemPrompt 是个函数而不是字符串：人设可以在设置页改，改完下一条消息就该生效，
// 不该为了换一句 prompt 重开会话（会话里有 inflight 请求，重开会把进行中的回复丢掉）。
export function createChatSession({ state, systemPrompt = '', getSystemPrompt = null } = {}) {
  let inflight = null; // { requestId, aborted }

  async function readAll(rid, onDelta) {
    const decoder = new TextDecoder('utf-8');
    let carry = '';
    let seq = 0;
    let text = '';

    for (let i = 0; i < MAX_CHUNKS; i++) {
      const chunk = await call('EllenModelHttp', 'read', { requestId: rid, sequence: seq + 1 });
      seq += 1;

      const b64 = chunk && chunk.data;
      if (b64) {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
        const piece = decoder.decode(bytes, { stream: true });
        carry += piece;

        // 按 SSE 事件切分：空行分隔；只认 data: 行
        let idx;
        while ((idx = carry.indexOf('\n\n')) >= 0) {
          const raw = carry.slice(0, idx);
          carry = carry.slice(idx + 2);
          for (const line of raw.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === '[DONE]') continue;
            try {
              const obj = JSON.parse(payload);
              const delta = obj && obj.choices && obj.choices[0] && obj.choices[0].delta;
              const piece2 = delta && (delta.content || '');
              if (piece2) {
                text += piece2;
                onDelta(text);
              }
            } catch {
              // 非 JSON 的 data 行直接跳过（服务端偶尔插 ping）
            }
          }
        }
      }

      if (chunk && chunk.done) break;
    }
    return text;
  }

  /**
   * 发一句话，等一条回复。
   * @param {string} text 用户说的话（语音消息就是转写文本——模型看这个，界面不看）
   * @param {{audio?: object, speech?: object}} [extra] 语音消息的附加字段，原样透传给这条用户消息
   */
  async function send(text, extra) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return;

    const cfg = state.getConfig();
    state.addMessage({ role: 'user', text: trimmed, ...(extra || {}) });

    const reply = state.addMessage({ role: 'assistant', text: '', pending: true });
    state.setError(null);

    if (!isUsable(cfg)) {
      state.updateMessage(reply.id, {
        text: '还没有配置聊天模型，先去设置里把 key 和模型填上。',
        pending: false,
      });
      return;
    }

    state.setBusy(true);
    // 保活：native 起前台服务把进程钉住，切走也能把这句说完
    keepAlive(true, { replyActive: true }).catch(() => {});
    const rid = newRequestId('chat');
    const ctl = { requestId: rid, aborted: false };
    inflight = ctl;

    try {
      const prefs = readChatPrefs();

      const history = state
        .getMessages()
        .filter((m) => m.id !== reply.id && !m.pending)
        .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }))
        .slice(-prefs.history);

      // 人设每轮现取：设置页改完立刻生效
      let sys = systemPrompt;
      if (typeof getSystemPrompt === 'function') {
        try {
          sys = await getSystemPrompt();
        } catch (err) {
          console.warn('[chat] 取人设失败，用空 system', err);
        }
      }

      const messages = sys ? [{ role: 'system', content: sys }, ...history] : history;

      // 记忆召回：把「她记得的事」拼进 system 段（不进聊天记录，界面看不到）
      let recalled = [];
      if (prefs.recall) {
        try {
          recalled = await recall(trimmed, { limit: prefs.recallLimit });
        } catch (err) {
          console.warn('[chat] 召回失败，这次不带记忆', err);
        }
      }
      if (recalled.length) {
        const block = renderRecall(recalled);
        const sysIdx = messages.findIndex((m) => m.role === 'system');
        if (sysIdx >= 0) messages[sysIdx] = { role: 'system', content: `${messages[sysIdx].content}\n\n${block}` };
        else messages.unshift({ role: 'system', content: block });
      }
      state.setRecall?.(recalled.map((r) => ({ kind: r.kind, title: r.title, score: r.score })));

      // 思考模式：聊天偏好优先，没设就跟随模型自身默认
      const think = prefs.thinking !== 'default' ? prefs.thinking : cfg.thinking || 'default';

      const body = JSON.stringify({
        model: cfg.model,
        stream: true,
        messages,
        ...(think && think !== 'default' ? { thinking: { type: think } } : {}),
      });

      const head = await call('EllenModelHttp', 'open', {
        requestId: rid,
        url: cfg.endpoint,
        apiKey: cfg.apiKey,
        body,
      });

      const status = head && head.status;
      if (typeof status === 'number' && status >= 400) {
        // 错误体也会走 read()，读一次把服务端的原话捞出来
        let detail = '';
        try {
          const first = await call('EllenModelHttp', 'read', { requestId: rid, sequence: 1 });
          if (first && first.data) {
            const bin = atob(first.data);
            const bytes = new Uint8Array(bin.length);
            for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
            detail = new TextDecoder('utf-8').decode(bytes);
          }
        } catch {
          /* 读不到错误体不阻塞 */
        }
        const explained = explainFailure(status, detail);
        const where = platformOf(cfg.platform);
        state.updateMessage(reply.id, {
          text: explained.text,
          detail: `HTTP ${status}${explained.code ? ` · ${explained.code}` : ''} · ${where.label}`,
          raw: detail.slice(0, 600),
          pending: false,
          failed: true,
        });
        return;
      }

      const finalText = await readAll(rid, (partial) => {
        // 流式只改内存：每个 chunk 都落库会把 revision 撑成几百条
        state.updateMessage(reply.id, { text: partial }, { persist: false });
      });

      state.updateMessage(reply.id, {
        text: finalText || '（这次没有说出话，可能是服务端没返回内容）',
        pending: false,
      });
    } catch (err) {
      const code = err && err.code;
      const aborted = ctl.aborted || code === 'CANCELLED';
      if (aborted) {
        // 停止时已经流出来的正文要留着（实测过：直接写「（已停止）」会把用户看到的那半截吃掉）。
        // 正文原样落库，停止标记只挂在细节行；一个字都还没出来时才把「（已停止）」放进正文。
        const cur = String((state.getMessages().find((m) => m.id === reply.id) || {}).text || '');
        state.updateMessage(reply.id, {
          text: cur || '（已停止）',
          detail: cur ? '（已停止）' : '',
          pending: false,
          failed: false,
        });
      } else {
        state.updateMessage(reply.id, {
          text: describeNativeError(code, err),
          detail: code || '',
          pending: false,
          failed: true,
        });
        state.setError(err);
      }
    } finally {
      if (inflight === ctl) inflight = null;
      state.setBusy(false);
      keepAlive(false).catch(() => {});
    }
  }

  function stop() {
    if (!inflight) return;
    inflight.aborted = true;
    call('EllenModelHttp', 'cancel', { requestId: inflight.requestId }).catch(() => {});
  }

  function refresh() {
    // 配置变了就刷新标题上的模型名
    const cfg = state.getConfig();
    if (cfg) state.setConfig(cfg);
  }

  return { send, stop, refresh };
}

/** 原生层 reject 的错误码 → 人话。 */
export function describeNativeError(code, err) {
  switch (code) {
    case 'INVALID_MODEL_HTTP_REQUEST':
      return '这次请求没发出去：服务地址或 key 的格式不合规。检查设置里的地址是不是以 https:// 开头。';
    case 'MODEL_HTTP_BUSY':
      return '上一条还在等回复，先等它收尾或点停止。';
    case 'MODEL_HTTP_DNS':
      return '找不到那个服务地址，检查设置里的域名有没有写错。';
    case 'MODEL_HTTP_TLS':
      return '和服务地址建立加密连接失败，可能是网络中间有拦截。';
    case 'MODEL_HTTP_CONNECT':
      return '连不上服务地址，检查网络，或者那个地址本身不通。';
    case 'MODEL_HTTP_TIMEOUT':
    case 'MODEL_HTTP_CONNECT_TIMEOUT':
      return '连接超时了，网络可能不稳，再发一次试试。';
    case 'MODEL_HTTP_READ_TIMEOUT':
      return '等回复等太久了，服务端那边慢。可以再发一次。';
    case 'MODEL_HTTP_LIMIT':
      return '回复太长超过了单次上限。';
    case 'MODEL_HTTP_REDIRECT':
      return '服务地址发生跳转被拦下了。把设置里的地址改成最终地址（别用会跳转的短链）。';
    case 'MODEL_HTTP_IO':
    case 'MODEL_HTTP_FAILED':
      return '请求中途断了，再发一次试试。';
    default:
      return `回复失败：${(err && (err.message || err.code)) || err}`;
  }
}
