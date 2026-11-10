// 一次性的模型提问（非流式）：拿一整段回答，不推给界面。
//
// 为什么不用 session.js 的流式通路：手记、记忆抽取这类后台加工不需要「一个字一个字冒出来」，
// 要的是「等它完整说完，再解析成结构化结果」。流式反而要多写一套拼接逻辑。
//
// 底层还是同两个原生方法（EllenModelHttp.open → read 直到 done），只是 body 里 stream:false，
// 然后把所有分块拼成整段文本再 JSON.parse。
import { call, requestId as newRequestId } from '../native/bridge.js';

const MAX_CHUNKS = 256; // 非流式一次几 KB，256 块足够；防死循环
const DEFAULT_TIMEOUT = 45_000;

/** 把 base64 分块拼成一个字符串（服务端可能返回 SSE 也可能是纯 JSON，两种都接）。 */
function decodeAll(chunks) {
  let acc = '';
  for (const b64 of chunks) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    acc += new TextDecoder('utf-8').decode(bytes);
  }
  return acc;
}

/**
 * 从响应体里抠出 content。
 * OpenAI 兼容端点非流式返回 `{choices:[{message:{content}}]}`；
 * 有些平台即使 stream:false 也回 SSE，所以这里两种都认。
 */
export function extractContent(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';

  // 纯 JSON
  if (text.startsWith('{')) {
    try {
      const j = JSON.parse(text);
      const msg = j && j.choices && j.choices[0] && (j.choices[0].message || j.choices[0].delta);
      const c = msg && (msg.content || msg.reasoning_content);
      if (typeof c === 'string') return c;
      if (typeof j.content === 'string') return j.content;
      if (typeof j.output_text === 'string') return j.output_text;
    } catch {
      /* 掉到下面按 SSE 试 */
    }
  }

  // SSE 拼接
  let acc = '';
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const obj = JSON.parse(payload);
      const delta = obj && obj.choices && obj.choices[0] && (obj.choices[0].delta || obj.choices[0].message);
      if (delta && typeof delta.content === 'string') acc += delta.content;
    } catch {
      /* 单行坏了不影响整体 */
    }
  }
  return acc;
}

/**
 * 问一次模型。
 * @param {object} opts
 * @param {object} opts.config  聊天配置（endpoint / apiKey / model / platform / thinking）
 * @param {Array<{role:string,content:string}>} opts.messages
 * @param {boolean} [opts.disableThinking] 后台加工统一关掉思考（老 bug ⑩：开着会拖几十秒还没内容）
 * @param {number} [opts.maxTokens]
 * @returns {Promise<string>} 模型正文
 */
export async function ask({ config, messages, disableThinking = true, maxTokens = 800 }) {
  if (!config || !config.endpoint) throw Object.assign(new Error('没有配置服务地址'), { code: 'NO_CONFIG' });

  const rid = newRequestId('oneshot');
  const body = JSON.stringify({
    model: config.model,
    stream: false,
    messages,
    max_tokens: maxTokens,
    ...(disableThinking ? { thinking: { type: 'disabled' } } : {}),
  });

  const head = await call('EllenModelHttp', 'open', {
    requestId: rid,
    url: config.endpoint,
    apiKey: config.apiKey,
    body,
  });

  const status = head && head.status;
  const chunks = [];
  let seq = 0;
  for (let i = 0; i < MAX_CHUNKS; i++) {
    const part = await call('EllenModelHttp', 'read', { requestId: rid, sequence: seq + 1 });
    seq += 1;
    if (part && part.data) chunks.push(part.data);
    if (!part || part.done) break;
  }

  const raw = decodeAll(chunks);

  if (typeof status === 'number' && status >= 400) {
    throw Object.assign(new Error(`HTTP ${status}`), { code: `HTTP_${status}`, raw });
  }
  return extractContent(raw);
}

/** 顺手把「```json … ```」这种围栏剥掉，模型爱这么写。 */
export function stripFence(text) {
  const t = String(text || '').trim();
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)```$/);
  return (m ? m[1] : t).trim();
}

/** 从一段文本里尽量抠出 JSON 对象（模型有时前后会多写两句话）。 */
export function looseJson(text) {
  const t = stripFence(text);
  try {
    return JSON.parse(t);
  } catch {
    /* 继续 */
  }
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch {
      /* 放弃 */
    }
  }
  return null;
}

export { DEFAULT_TIMEOUT };
