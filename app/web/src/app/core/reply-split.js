// 拆条：把一段完整回复切成几条气泡，像真的在聊天。
//
// 为什么不按字数硬切：中文没有词间空格，按字符数切必然切在词中间
// （「今天的/天气」这种），读起来像被打断。模型本来就是一句一句写的，
// 按句末标点切出来的边界天然就是语义边界。
//
// 代码块与引号里的内容一个字符都不许动：切进 ``` 会把围栏拆成奇数个、
// 后面整段渲染塌成纯文本；切进「他说『……』」会把引号拆成两条，
// 每条各缺一半，气泡里就剩一堆孤立的引号。
//
// 纯函数、无 DOM：native/后台/测试都能直接 import 跑。

/** 句末标点：只有这些算一条说完（分号不算，它是同句里的停顿）。 */
const SENTENCE_END = new Set(['。', '！', '？', '!', '?', '…', '~', '～']);

/** 二级切分点：单句太长时的兜底，切在这类停顿上读起来还算顺。 */
const CLAUSE_BREAK = new Set(['，', '、', '；', ',', ';']);

/** 拆条默认值。max 是气泡数上限，minLen 是不值得单独成条的字符数。 */
export const SPLIT_LIMITS = { max: 3, minLen: 6, maxChars: 60 };

/** 中文字符按码点算长度，emoji 不算两个。 */
function len(text) {
  let n = 0;
  for (const _ of text) n += 1;
  return n;
}

/** 去掉结尾的收尾符号后，看这句话是不是已经收住了。 */
function endsWithEnd(text) {
  let i = text.length - 1;
  while (i >= 0 && '」』”’）)】]'.includes(text[i])) i -= 1;
  return i >= 0 && SENTENCE_END.has(text[i]);
}

/**
 * 切句：按句末标点与换行扫描，括号/引号/代码块内部不切。
 * @param {string} text
 * @returns {string[]} 已 trim 的句子数组
 */
function scanSentences(text) {
  const out = [];
  let buf = '';
  let fence = false; // 是否在 ``` 围栏内
  let paren = 0; // （）()【】[] 深度
  let quote = 0; // 「」『』“”‘’ 与成对直引号深度

  const flush = () => {
    const t = buf.trim();
    if (t) out.push(t);
    buf = '';
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (ch === '`' && text.startsWith('```', i)) {
      fence = !fence;
      buf += '```';
      i += 2;
      continue;
    }

    buf += ch;
    if (fence) continue;

    if (ch === '（' || ch === '(' || ch === '【' || ch === '[') paren += 1;
    else if (ch === '）' || ch === ')' || ch === '】' || ch === ']') paren = Math.max(0, paren - 1);
    else if (ch === '「' || ch === '『' || ch === '“' || ch === '‘') quote += 1;
    else if (ch === '」' || ch === '』' || ch === '”' || ch === '’') quote = Math.max(0, quote - 1);
    else if (ch === '"' || ch === "'") quote = quote ? quote - 1 : quote + 1;

    // 括号或引号还没闭合：里面的标点不是句末
    if (paren > 0 || quote > 0) continue;

    if (ch === '\n') {
      flush();
      continue;
    }
    if (!SENTENCE_END.has(ch)) continue;

    // 连续的句末标点归同一条（「真的？！」拆成两条会很怪）
    while (i + 1 < text.length && SENTENCE_END.has(text[i + 1])) {
      i += 1;
      buf += text[i];
    }
    flush();
  }
  flush();
  return out;
}

/** 把 b 接在 a 后面：a 已经收句就直连，没收句（换行切出来的）就保留换行。 */
function joinText(a, b) {
  if (!a) return b;
  return a + (endsWithEnd(a) ? '' : '\n') + b;
}

/** 过短的句子并进邻句：往后攒，攒不够就贴到上一条。 */
function mergeShort(sentences, minLen) {
  const out = [];
  let acc = '';
  for (const piece of sentences) {
    acc = acc ? joinText(acc, piece) : piece;
    if (len(acc) >= minLen) {
      out.push(acc);
      acc = '';
    }
  }
  if (acc) {
    if (out.length) out[out.length - 1] = joinText(out[out.length - 1], acc);
    else out.push(acc);
  }
  return out;
}

/** 单句超长：按逗号顿号贪心打包到 maxChars 以内。没有可切的就原样返回。 */
function splitLong(sentence, maxChars) {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return [sentence];
  if (len(sentence) <= maxChars) return [sentence];

  const parts = [];
  let buf = '';
  for (const ch of sentence) {
    buf += ch;
    if (CLAUSE_BREAK.has(ch)) {
      parts.push(buf);
      buf = '';
    }
  }
  if (buf) parts.push(buf);
  if (parts.length < 2) return [sentence]; // 整句一个逗号都没有，硬切只会更难读

  const packed = [];
  let cur = '';
  for (const p of parts) {
    if (cur && len(cur + p) > maxChars) {
      packed.push(cur);
      cur = p;
    } else {
      cur += p;
    }
  }
  if (cur) packed.push(cur);
  return packed;
}

/**
 * 把一条回复切成若干气泡。
 * @param {string} text 模型返回的整段文本
 * @param {{max?:number, minLen?:number, maxChars?:number}} [opts]
 *   max 气泡上限（超出就把尾部的并回上一条）；minLen 短句阈值；maxChars 二级切分阈值
 * @returns {{text:string, segIndex:number, segCount:number}[]} 空文本返回 []
 */
export function splitReply(text, opts = {}) {
  if (text == null) return [];
  const src = String(text).replace(/\r\n?/g, '\n').trim();
  if (!src) return [];

  const max = Math.max(1, Math.round(Number(opts.max) || SPLIT_LIMITS.max));
  const minLen = Math.max(1, Math.round(Number(opts.minLen) || SPLIT_LIMITS.minLen));
  const maxChars = opts.maxChars === undefined ? SPLIT_LIMITS.maxChars : Number(opts.maxChars);

  let segs = mergeShort(scanSentences(src), minLen);
  if (maxChars > 0) segs = segs.flatMap((s) => splitLong(s, maxChars));

  // 段数超上限：把尾巴一段一段并回去（保留前面的完整句子作为独立气泡）
  while (segs.length > max) {
    const tail = segs.pop();
    segs[segs.length - 1] = joinText(segs[segs.length - 1], tail);
  }

  return segs.map((s, i) => ({ text: s, segIndex: i, segCount: segs.length }));
}

/**
 * 用户是否开着拆条。默认开：拆条是「像在聊天」的核心手感，关掉要显式关。
 * localStorage 在 node 里不存在，读不到一律按默认值走。
 */
export function shouldSplit() {
  try {
    const raw = localStorage.getItem('ellen.chat.v1');
    if (!raw) return true;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return true;
    return parsed.split !== false;
  } catch {
    return true;
  }
}
