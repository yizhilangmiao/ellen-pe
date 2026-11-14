// 上下文预算：决定这一次请求到底带多少历史。
//
// 为什么需要它：在这之前整个请求只有「条数」这一个旋钮（chatprefs.history，
// 默认 20 条），没有任何 token 计数。日常聊天约 2900 字、够用；但贴一篇长文、
// 或者把条数调到 50，8k 窗口的模型当场就满了，服务端回 400，而 explainFailure()
// 那时候给的话是「多半是模型名不对」——把人引到错误的方向去。
//
// 这里只做纯计算，不碰 UI、不碰存储：给定一串消息和一份预算，回答「带哪几条」。
// 估算是保守的（中文 1 字按 1 token 算），宁可少带，不要爆。

/** 每个已知模型的上下文窗口（token）。没写在表里的按 DEFAULT_WINDOW 走。 */
export const MODEL_WINDOWS = {
  'moonshot-v1-8k': 8192,
  'moonshot-v1-32k': 32768,
  'qwen-turbo': 32768,
  'qwen-plus': 32768,
  'qwen-max': 32768,
  'glm-4-flash': 32768,
  'glm-4-plus': 32768,
  'deepseek-chat': 32768,
  'deepseek-reasoner': 32768,
  'deepseek-ai/DeepSeek-V3': 32768,
  'Qwen/Qwen2.5-7B-Instruct': 32768,
};

/** 认不出模型时的保守值：多数在售模型都 ≥ 32k，但真遇到 8k 的靠溢出重试兜底。 */
export const DEFAULT_WINDOW = 16384;

/** 预留给回复的 token。她的设定是「短」，长句模式才放宽。 */
export const REPLY_BUDGET = { short: 400, normal: 700, long: 1200 };

/** 安全系数：估算本身有误差（英文/数字的分词密度和中文不同），留 20% 余量。 */
const SAFETY = 0.8;

export function windowOf(model) {
  const id = String(model || '').trim();
  if (!id) return DEFAULT_WINDOW;
  if (MODEL_WINDOWS[id]) return MODEL_WINDOWS[id];
  // 用户可能写 moonshot-v1-8k-xxx 这种带后缀的名字，按包含关系再认一次
  for (const key of Object.keys(MODEL_WINDOWS)) {
    if (id.includes(key)) return MODEL_WINDOWS[key];
  }
  return DEFAULT_WINDOW;
}

export function replyBudgetOf(length) {
  return REPLY_BUDGET[length] || REPLY_BUDGET.normal;
}

/**
 * 粗估一段文字要多少 token。
 *
 * 中文按 1 字 1 token 算（实际约 0.6~0.7，多算的部分当余量）；
 * ASCII 按 4 字符 1 token；换行当 1 token。
 */
export function estimateTokens(text) {
  const s = String(text || '');
  if (!s) return 0;
  let cjk = 0;
  let ascii = 0;
  let breaks = 0;
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code === 10 || code === 13) breaks += 1;
    else if (code > 0x2e80) cjk += 1;
    else ascii += 1;
  }
  return Math.ceil(cjk + ascii / 4 + breaks * 0.5);
}

/** 估算一整串 messages 的 token。图片部分（数组 content）按固定值算。 */
export function estimateMessages(messages) {
  let total = 0;
  for (const m of messages || []) {
    if (typeof m.content === 'string') total += estimateTokens(m.content) + 4;
    else if (Array.isArray(m.content)) {
      // 视觉消息：一张图按 800 token 粗算（各家不一，这里只求不低估到溢出）
      const text = m.content.filter((p) => p && p.type === 'text').map((p) => p.text).join(' ');
      total += estimateTokens(text) + 800 + 4;
    }
  }
  return total;
}

/** 这次请求总共能用多少 token 给「输入」部分。 */
export function inputBudgetOf({ model, replyLength } = {}) {
  const win = windowOf(model);
  const reply = replyBudgetOf(replyLength);
  return Math.max(1024, Math.floor((win - reply) * SAFETY));
}

/**
 * 按预算裁历史：从最老的一条开始丢，直到放得下。
 *
 * 两条硬规矩：
 *   1. 至少留最近 4 条（两轮）。宁可这一条超一点点，也不要把上下文砍成光杆——
 *      一句话带出去她照样能答，只是接不住上文，比直接报错好。
 *   2. 不裁当前这条 user（调用方传进来的最后一条就是要回的那句）。
 *
 * @returns {{ kept: Array, dropped: number, tokens: number, budget: number }}
 */
export function trimHistory(history, budget, { minKeep = 4 } = {}) {
  const list = Array.isArray(history) ? history : [];
  const total = estimateMessages(list);
  if (total <= budget) return { kept: list.slice(), dropped: 0, tokens: total, budget };

  let start = 0;
  let tokens = total;
  const floor = Math.max(0, list.length - minKeep);
  while (tokens > budget && start < floor) {
    tokens -= estimateMessages([list[start]]);
    start += 1;
  }
  return { kept: list.slice(start), dropped: start, tokens, budget };
}

/**
 * 服务端说「太长」时的降级：保留 system 头 + 后半段历史，砍掉前一半再说一次。
 *
 * 抽成纯函数是因为这一步是「用户无感」的命门：砍多了白丢上下文，砍少了
 * 重发还是超限，而这条路径平时根本走不到（预算算得准就永远不触发），
 * 只能靠单测盯。session 那边只剩一层 for 循环。
 */
export function shrinkForRetry(messages, { minKeep = 2 } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  if (!list.length) return [];
  const head = list[0] && list[0].role === 'system' ? list[0] : null;
  const rest = head ? list.slice(1) : list.slice();
  if (!rest.length) return head ? [head] : [];
  const keep = Math.max(minKeep, Math.floor(rest.length / 2));
  const kept = rest.slice(-keep);
  return head ? [head, ...kept] : kept;
}

/**
 * 把「拆条」产生的多段并回一条 assistant。
 *
 * 拆条是为了气泡好看：一条回复切两三条发出来（core/reply-split.js），落库时
 * 是各自独立的消息，带 segIndex/segCount。如果不合并，history=20 条时实际
 * 只带得回约 7 轮对话——预算被气泡数吃掉了，而且模型看到的是三段互不相干的
 * 短句，接不上是同一口气说完的。
 */
export function mergeSplitSegments(messages) {
  const out = [];
  for (const m of messages || []) {
    if (!m) continue;
    const last = out[out.length - 1];
    const texty = typeof m.content === 'string' && last && typeof last.content === 'string';
    if (m.segIndex > 0 && last && last.role === m.role && texty) {
      last.content = `${last.content}\n${m.content}`;
      continue;
    }
    // 只留 API 认识的字段。segIndex / segCount / id 是本地气泡用的壳，
    // 原样塞进请求体，严格的 OpenAI 兼容实现会因为未知字段直接回 400。
    out.push({ role: m.role, content: m.content });
  }
  return out;
}
