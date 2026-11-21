// 采样参数：让回复别那么「趋中」。
//
// 为什么要有这个文件：
//   聊天请求里一直只传 model / stream / messages / max_tokens，
//   温度、top_p、重复惩罚全走服务商默认（多数是 1.0 / 1.0 / 0）。
//   默认值的问题不是「错」，而是「稳」—— 每次都挑最可能的那个说法，
//   读起来就是那种均匀、得体、没有毛刺的助手腔：句句正确，句句不出人意料。
//   真人说话是有抖动的：这儿省一个字，那儿岔一句，偶尔冒出个不搭界的词。
//
// 取值刻意保守（0.9 / 0.95 / 0.3）：再往上容易跑题、开始编设定；
// 0.9 的作用只是把「最安全的那句」之外的次优解放进来一点。
//
// Anthropic 的 messages 接口不收 presence_penalty（会 400），所以按端点/模型名跳过。
// 另有一道兜底在上层：服务端明确说不认识某个参数时，去掉参数重发一次（见 chat/session.js）。
export const SAMPLING = { temperature: 0.9, top_p: 0.95, presence_penalty: 0.3 };

/**
 * 这次请求该带哪些采样参数。
 * @param {{endpoint?:string, model?:string}} cfg 发送配置（config.js 的 sendCfg）
 * @returns {Record<string, number>} 直接展开进请求体
 */
export function samplingFor(cfg = {}) {
  const url = String(cfg.endpoint || '');
  const model = String(cfg.model || '');
  const anthropic = /\/v1\/messages\b/.test(url) || /^claude/i.test(model);
  const out = { temperature: SAMPLING.temperature, top_p: SAMPLING.top_p };
  if (!anthropic) out.presence_penalty = SAMPLING.presence_penalty;
  return out;
}

/**
 * 这个 4xx 是在骂参数吗（而不是上下文超长、鉴权、限流）？
 * 骂参数才去掉重发；别的错照样按原样报给用户，别把真实原因咽掉。
 */
export function looksLikeParamReject(status, detail) {
  if (status !== 400 && status !== 422) return false;
  const d = String(detail || '');
  if (/context|token.{0,6}length|too long|maximum/i.test(d) && !/parameter/i.test(d)) return false;
  return /temperature|top_p|top\s*p|presence_penalty|frequency_penalty|unsupported|unknown|invalid[_ ]?parameter|not support/i.test(d);
}
