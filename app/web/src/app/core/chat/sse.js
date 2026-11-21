// SSE 增量解析：把「一块一块到达的字节文本」拼成 model 吐出来的正文。
//
// 为什么单独拆出来：这段逻辑只有一条规律（空行分事件、只认 data: 行、
// 逐块追加），但它的边界情况（CRLF、尾巴没有空行、chunk 把 `\r` 和 `\n` 劈开）
// 全是最容易丢字的地方，而它埋在聊天会话的闭包里根本测不到。
// 拆成纯函数后可以脱离原生层直接单测（见 app/web/_临时/*.mjs）。

/**
 * @param {(text: string) => void} [onDelta] 每吃进一段正文就回调一次「到目前为止的全文」
 * @returns {{feed:(piece:string)=>void, flush:()=>string, text:()=>string}}
 */
export function createSseReader(onDelta) {
  let carry = '';
  let text = '';

  const consume = (raw) => {
    if (!raw) return;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      // `data: [DONE]` 是流结束标记，不是内容
      if (payload === '[DONE]') continue;
      try {
        const obj = JSON.parse(payload);
        const delta = obj && obj.choices && obj.choices[0] && obj.choices[0].delta;
        const piece = delta && (delta.content || '');
        if (piece) {
          text += piece;
          if (onDelta) onDelta(text);
        }
      } catch {
        // 非 JSON 的 data 行直接跳过（服务端偶尔插 ping/心跳）
      }
    }
  };

  return {
    feed(piece) {
      if (!piece) return;
      carry += piece;
      // 有的平台用 CRLF 分隔事件（`\r\n\r\n`），只认 `\n\n` 的话一个事件都切不出来，
      // 整段话要等流结束才一次性冒出来。统一成 LF；被 chunk 边界切开的 `\r`+`\n`
      // 会在下一轮拼回 carry 时再换，所以这里随便切都没关系。
      carry = carry.replace(/\r\n/g, '\n');
      let idx;
      while ((idx = carry.indexOf('\n\n')) >= 0) {
        const raw = carry.slice(0, idx);
        carry = carry.slice(idx + 2);
        consume(raw);
      }
    },
    /**
     * 流结束：carry 里剩下的那一帧没有结尾空行，但它**是内容**。
     * 以前直接丢掉，表现就是「话说到一半停住，少最后几个字」。
     * @returns {string} 全文
     */
    flush() {
      if (carry.trim()) consume(carry);
      carry = '';
      return text;
    },
    text() {
      return text;
    },
  };
}
