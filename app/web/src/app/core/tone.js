// 语气标注：模型在句首写「（轻声）」「（笑着）」，这层把它摘出来，
// 文本进气泡、语气名进朗读参数。
//
// 为什么不把括号留在文本里：气泡里挂一个「（轻声）」很出戏，
// 而朗读端拿不到它就没法降速。拆成两个字段，显示与朗读各取所需。
//
// 纯函数、无 DOM；读 localStorage 的两个入口都做了 try/catch（node/测试里没有）。

/** 语气 → 朗读参数。rate 越大越快，pitch 越大越高。 */
const TONE_RATES = {
  轻声: { rate: 0.92, pitch: 1.02 },
  小声: { rate: 0.9, pitch: 1.0 },
  低声: { rate: 0.9, pitch: 0.98 },
  嘟囔: { rate: 0.94, pitch: 1.0 },
  嘀咕: { rate: 0.94, pitch: 1.0 },
  笑着: { rate: 1.06, pitch: 1.08 },
  笑: { rate: 1.06, pitch: 1.08 },
  打趣: { rate: 1.04, pitch: 1.06 },
  俏皮: { rate: 1.04, pitch: 1.06 },
  撒娇: { rate: 1.03, pitch: 1.08 },
  认真: { rate: 0.98, pitch: 0.96 },
  严肃: { rate: 0.96, pitch: 0.94 },
  叹气: { rate: 0.88, pitch: 0.94 },
  无奈: { rate: 0.94, pitch: 0.95 },
  委屈: { rate: 0.92, pitch: 1.04 },
  害羞: { rate: 1.02, pitch: 1.06 },
  冷淡: { rate: 0.96, pitch: 0.94 },
  温柔: { rate: 0.96, pitch: 1.04 },
  平静: { rate: 0.99, pitch: 1.0 },
  犹豫: { rate: 0.95, pitch: 1.0 },
  急促: { rate: 1.1, pitch: 1.05 },
  兴奋: { rate: 1.08, pitch: 1.08 },
};

export const TONES = Object.keys(TONE_RATES);

/** 句首标注：全角/半角括号，里面 1–4 个字（「（轻声）」），允许前导空白。 */
const TONE_HEAD = /^[\s]*[（(]\s*([^（）()\s]{1,4})\s*[）)][\s]*/;

/**
 * 摘掉句首语气标注。
 * @param {string} text
 * @returns {{text:string, tone:string}} tone 为语气名（认不出来的括号原样保留，tone 为 ''）
 */
export function extractTone(text) {
  const src = text == null ? '' : String(text);
  const m = src.match(TONE_HEAD);
  if (!m) return { text: src, tone: '' };
  const word = m[1];
  // 只吃认得的词：括号里也可能是「（明天）好」这种正常内容，误剥会改意思
  if (!TONE_RATES[word]) return { text: src, tone: '' };
  return { text: src.slice(m[0].length), tone: word };
}

/** 契约名（`takeTone`）：同一个实现，返回字段名一致。 */
export const takeTone = extractTone;

/**
 * 语气 → 朗读参数。认不出返回 1/1（不调），保证调用方永远能直接拐进 TTS 参数。
 * @param {string} tone
 * @returns {{rate:number, pitch:number}}
 */
export function toneToRate(tone) {
  const hit = TONE_RATES[String(tone || '').trim()];
  return hit ? { ...hit } : { rate: 1, pitch: 1 };
}

/**
 * 契约名（`toneToSpeech`）：未命中返回空对象，调用方可以据此判断「要不要覆盖语速」。
 * @param {string} tone
 * @returns {{rate:number, pitch:number}|{}}
 */
export function toneToSpeech(tone) {
  const hit = TONE_RATES[String(tone || '').trim()];
  return hit ? { ...hit } : {};
}

/** 用户是否开着语气标注。默认开；读不到 localStorage 按开处理。 */
export function toneEnabled() {
  try {
    const raw = localStorage.getItem('ellen.chat.v1');
    if (!raw) return true;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return true;
    return parsed.tone !== false;
  } catch {
    return true;
  }
}
