// 聊天正文的轻量富文本。
//
// 为什么要它：模型回的是 Markdown，旧包会把 **粗体** 渲染出来；直接 textContent 会原样吐出
// `**24小时完全不吃**`，看着像坏掉了。
//
// 这里只做「不可能出错」的那一小撮：转义 → 粗体 → 行内代码 → 换行。
// 不做标题 / 列表 / 表格 / 链接：一是没必要（对话里很少），二是自己写 Markdown 解析器
// 迟早会在某个边界上把 HTML 漏出去。真要完整渲染就引 marked + DOMPurify，而不是手写。
const ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

/**
 * 把一段模型输出转成可安全写进 innerHTML 的字符串。
 * @param {string} text
 * @returns {string}
 */
export function renderRichText(text) {
  let out = escapeHtml(text == null ? '' : text);
  // 行内代码先占位，避免里面的星号被当成粗体
  const codes = [];
  out = out.replace(/`([^`\n]{1,200})`/g, (_, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  // 粗体：**x**（内容里不允许再出现星号）
  out = out.replace(/\*\*([^*\n]{1,400})\*\*/g, '<strong>$1</strong>');
  // 还原行内代码
  out = out.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
  // 动作/神态描写：把括号里的内容换一种写法（细一点、斜一点），读起来跟对话分得开。
  // 老大原话：「文字里夹杂动作，为了可读性，（动作...）使用其他字体，或者斜体变细」。
  // 只认 1~80 字的短括号，不跨行；标签内部（strong/code）里若出现括号也照样包，嵌在里面的 span 合法。
  out = out.replace(/[（(]([^（）()<>\n]{1,80})[）)]/g, (whole, inner) => {
    const lead = whole.startsWith('（') ? '（' : '(';
    const tail = whole.endsWith('）') ? '）' : ')';
    return `<span class="el-act">${lead}${inner}${tail}</span>`;
  });
  // 换行不转 <br>：气泡本身是 white-space: pre-wrap，转成 <br> 会变成双倍行距。
  return out;
}
