// M4: 改由 核心\ 实现
/**
 * 发出前的最后一道打磨（reply polish）。
 *
 * 干什么：① 去掉助手腔的尾巴（「希望对你有帮助」「还有什么想问的随时说」）；
 *        ② 一条回复里问号多了，只留第一个。
 *
 * 为什么放在这里而不是写进 prompt：prompt 里的禁令是概率性的，模型会漏；
 * 这两件事是确定性的，用代码做一次比在提示词里再加一行「不要问两次」可靠。
 * 而且它只动尾巴和多余的问句，不碰她的语气、不重写正文，所以不会把人味改掉。
 *
 * 为什么问号只留一个：连问两三句是「客服三连」最典型的形状（「你还好吗？要不要
 * 休息一下？需要我帮忙吗？」）。留一个问句 + 后面的话，读起来才像人在说，
 * 而不是把选择权一整套递给对方。删的是整句问句，不删陈述句。
 */

/**
 * 尾巴特征：**整句**命中就删整句。
 * 为什么按句判断而不是全文正则替换：全文替换会连正文一起吃
 * （「我理解你的意思」在句中被命中，前面半句就丢了）；按句判断最多误删一句，
 * 且误删的那句本来就是助手腔。
 */
export const TAIL_TESTS = [
  /希望(?:这|以上|这些|它)?(?:能|可以)?(?:对|帮)(?:到)?(?:你|您)/, // 希望对你有帮助 / 希望这能帮到你
  /^(?:但)?(?:希望|祝)(?:你|您)/, // 祝你有美好的一天
  /(?:还)?有(?:什么|其他|别的)?(?:问题|需要|想聊的|想说的|想问的|要问的)/, // 还有什么想问的
  /(?:什么|啥)(?:可以|能)?(?:帮|为)(?:你|您)(?:做|的)/, // 有什么可以帮到你
  /作为(?:一个)?\s*(?:AI|人工智能|语言模型|助手)/i, // 作为 AI
  /^我(?:很)?(?:理解|明白)(?:你|您)的?(?:感受|心情)/, // 我理解你的感受，但是……
  /^(?:还)?(?:需要|要)(?:我|帮忙)(?:做|帮)?(?:点|些)?(?:什么|别的)?吗/, // 还需要我做什么吗
  /^(?:还有|有)(?:别的|其他)?(?:事|问题)(?:吗|么)/, // 还有别的事吗
];

/** 分句：句末标点或换行之后切开，标点留在前一句里。 */
const CLAUSE_SPLIT = /(?<=[。！!？?\n])/;

/** 问句（到问号为止的一段，不含前面的句末标点）。 */
const QUESTION = /[^。！!？?\n]*？/g;

/**
 * 删掉助手腔的尾巴（按整句删）。
 * @param {string} text
 * @returns {{text: string, removed: string[]}}
 */
export function stripAssistantTail(text) {
  const s = String(text || '');
  if (!s.trim()) return { text: s, removed: [] };

  const removed = [];
  const kept = [];
  for (const clause of s.split(CLAUSE_SPLIT)) {
    const body = clause.replace(/^[\s，,、；;]+/, '');
    if (!body.trim()) continue;
    // 先看句内：有逗号时先把后半的尾巴砍掉，别把前面的正经话一起扔掉
    // （「早点睡，希望这能帮到你。」→ 只砍逗号后面）。
    const parts = body.split(/(?<=[，,])/);
    while (parts.length > 1) {
      const last = parts[parts.length - 1].replace(/^[，,\s]+/, '');
      if (!TAIL_TESTS.some((re) => re.test(last))) break;
      removed.push(last.trim());
      parts.pop();
    }
    const rest = parts.join('');
    if (!rest.trim()) continue;
    // 砍剩下的部分整句还是尾巴 → 整句删
    if (TAIL_TESTS.some((re) => re.test(rest.trim()))) {
      removed.push(rest.trim());
      continue;
    }
    kept.push(rest);
  }
  if (!removed.length) return { text: s, removed };

  // 删完可能留下孤零零的标点或空行：「嗯，我在。 。 」→「嗯，我在。」
  const out = kept
    .join('')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/([。！!？?～~…])[，,、；;\s]+(?=[。！!？?～~…])/g, '$1')
    // 砍掉句内尾巴后可能剩个逗号收尾：「早点睡，」→「早点睡。」
    .replace(/([^。！!？?\n\s])[，,]\s*$/g, '$1。')
    .replace(/^[，,、；;。！!？?\s]+/, '')
    .replace(/\s+$/g, '');
  return { text: out, removed };
}

/**
 * 只留前 max 个问句，其余问句整句删掉。
 * @param {string} text
 * @param {{max?: number}} opts max = 保留几个问句，默认 1
 * @returns {{text: string, removed: string[]}}
 */
export function trimQuestions(text, { max = 1 } = {}) {
  const s = String(text || '');
  const qs = [...s.matchAll(QUESTION)];
  if (qs.length <= max) return { text: s, removed: [] };

  // 从后往前删，前面的下标才不会错位
  let out = s;
  const removed = [];
  for (let i = qs.length - 1; i >= max; i -= 1) {
    const hit = qs[i];
    const at = hit.index ?? 0;
    const body = String(hit[0]);
    // 问句前面连着换行的话，把换行一起吃掉，免得留下空行
    const start = at > 0 && out[at - 1] === '\n' ? at - 1 : at;
    removed.unshift(body.trim());
    out = out.slice(0, start) + out.slice(at + body.length);
  }
  return { text: out.trim(), removed };
}

/**
 * 一句话打磨完：先尾巴，再问号。
 * @param {string} text
 * @param {{maxQuestions?: number}} opts
 * @returns {{text: string, tail: string[], questions: string[], changed: boolean}}
 */
export function polishReply(text, { maxQuestions = 1 } = {}) {
  const raw = String(text || '');
  if (!raw.trim()) return { text: raw, tail: [], questions: [], changed: false };

  const a = stripAssistantTail(raw);
  const b = trimQuestions(a.text, { max: maxQuestions });

  // 兜底：删过头了（剩不到两个字）就退回上一步，宁可留着尾巴也别发个空泡
  let out = b.text;
  if (out.replace(/[\s。！!？?～~…（）()]/g, '').length < 2) {
    out = a.text.trim() || raw;
  }
  const changed = out !== raw;
  return { text: out, tail: a.removed, questions: b.removed, changed };
}

/** 给日志用的一句话摘要。别把整段回复打进来，只报删了什么。 */
export function describePolish(result) {
  if (!result || !result.changed) return '';
  const bits = [];
  if (result.tail.length) bits.push(`尾巴 ${result.tail.length} 处：${result.tail.join(' / ')}`);
  if (result.questions.length) bits.push(`多余问句 ${result.questions.length} 个：${result.questions.join(' / ')}`);
  return bits.length ? `reply-polish ${bits.join('；')}` : '';
}
