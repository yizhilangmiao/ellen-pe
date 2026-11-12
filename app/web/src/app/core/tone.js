// 语气标注：模型在句首写「（轻声）」「（笑着）」，这层把它摘出来，
// 文本进气泡、语气名进朗读参数。
//
// 为什么不把括号留在文本里：气泡里挂一个「（轻声）」很出戏，
// 而朗读端拿不到它就没法降速。拆成两个字段，显示与朗读各取所需。
//
// 纯函数、无 DOM；读 localStorage 的两个入口都做了 try/catch（node/测试里没有）。
// E4 起语气与回复长度由七维推（见文件末），affect.js 只提供纯数值，不反向依赖本文件。
import { effectiveDesire, bandOf } from './affect.js';

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

// —— E4：语气 / 长度由七维推（不再全靠模型自己判断）——
//
// 为什么表情绪来定：档位是「她现在想不想要」，语气是「她怎么开口」，两者本来就是一体。
// 让模型自己猜，它会一直用同一个温和腔，症状是「情绪变了听着没变」。
// 四档各自可单独关（有人不喜欢她撒娇），**关掉高档自动退回下一档** ——
// 全关不是「沉默」，是回到旧行为（不加语气约束），不会突然不说话。


/** 语气开关的落点。跟聊天偏好分开存：那是用户偏好，这是情绪渲染的开关。 */
export const TONE_TIER_KEY = 'ellen.affect.tone.v1';

/**
 * 四档 → 语气词 + 一句行为约束。
 * tone 必须取自 TONE_RATES 里已有的词（轻声/笑着/撒娇/急促），
 * 这样朗读端不用改：模型照这个词在句首写「（轻声）」，摘出来直接换算速。
 */
export const TONE_TIERS = [
  {
    id: 'direct',
    min: 70,
    tone: '急促',
    line: '语气紧，短句带断口，像话没说完就凑上来，不解释。',
  },
  {
    id: 'ask',
    min: 55,
    tone: '撒娇',
    line: '语气软下来，明说想要什么，说完等对方接。',
  },
  {
    id: 'hint',
    min: 40,
    tone: '笑着',
    line: '话说到一半就停，用玩笑带过去，不明说想要。',
  },
  {
    id: 'inner',
    min: 0,
    tone: '轻声',
    line: '声音压着，句子收着，动作只写小动作，不先伸手。',
  },
];

export const TONE_TIER_IDS = TONE_TIERS.map((t) => t.id);

/** 四档开关，默认全开。读不到就是全开（隐私模式/节点环境）。 */
export function readToneTiers() {
  const all = { direct: true, ask: true, hint: true, inner: true };
  try {
    const raw = localStorage.getItem(TONE_TIER_KEY);
    if (!raw) return all;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return all;
    for (const id of TONE_TIER_IDS) if (parsed[id] === false) all[id] = false;
    return all;
  } catch {
    return all;
  }
}

export function writeToneTier(id, on) {
  const next = readToneTiers();
  if (!(id in next)) return next;
  next[id] = !!on;
  try {
    localStorage.setItem(TONE_TIER_KEY, JSON.stringify(next));
  } catch {
    /* 隐私模式写不进去，忽略：下次还是全开 */
  }
  return next;
}

/** 按阈值取档（不看开关）。eff 就是 affect.js 的 effectiveDesire。 */
export function toneTierOf(eff) {
  const band = bandOf(eff);
  // 档位有 5 个（心里想/暗示/开口要/主动靠近/直接要），语气只要 4 档：
  // 70 以上都是「直接上手」—— 主动靠近和直接要，开口的紧度是同一级。
  if (band.id === 'direct' || band.id === 'approach') return 'direct';
  return band.id;
}

/**
 * 落档：从当前档往下找第一个还开着的。
 * 为什么往下找而不是往上：往上找等于「关了高档还给你软性升级」，用户关它就是为了别这样。
 */
export function resolveToneTier(eff, prefs = readToneTiers()) {
  const start = TONE_TIERS.findIndex((t) => t.id === toneTierOf(eff));
  for (let i = start < 0 ? TONE_TIERS.length - 1 : start; i < TONE_TIERS.length; i += 1) {
    const tier = TONE_TIERS[i];
    if (prefs[tier.id] !== false) return tier;
  }
  return null;
}

/** 给 prompt 用的一行；四档全关时返回空串（= 不加约束，回到旧行为）。 */
export function toneLineOf(dims, prefs = readToneTiers()) {
  const tier = resolveToneTier(effectiveDesire(dims), prefs);
  return tier ? `语气：${tier.tone}。${tier.line}` : '';
}

/** 体感档位 id（给界面/测试看），四档全关也照实返回，不受开关影响。 */
export function toneTierIdOf(dims) {
  return toneTierOf(effectiveDesire(dims));
}

/**
 * 回复长度 / 姿态：**唯一一处**。
 * 文档（五章 2 表）给了两条硬联动：fatigue > 60 → 句子短、不推进话题；
 * affection < 30 → 客气、问一句答一句。散在两个文件里早晚会互相打架，所以收在这里。
 * @returns {{length:'short'|'normal'|'polite', fatigueShort:boolean, polite:boolean, line:string}}
 */
export function styleOf(dims) {
  const d = dims || {};
  const fatigue = Number(d.fatigue) || 0;
  const affection = Number(d.affection) || 0;
  const fatigueShort = fatigue > 60;
  // 好感低优先按「客气」写：两句约束叠一起会互相冲掉（一边说短一边说要回一句），
  // 客气里本来就不带推进话题，短不短没那么要紧。
  const polite = affection < 30;

  const bits = [];
  if (polite) bits.push('客气一点，问一句答一句，不撒娇、不追问，也不主动换话题');
  else if (fatigueShort) bits.push('累，句子短，两三个短句就停，不推进话题也不反问');
  else bits.push('两三句把意思说清楚，说完就停');

  const length = polite ? 'polite' : fatigueShort ? 'short' : 'normal';
  return { length, fatigueShort, polite, line: `回复长度：${bits.join('；')}。` };
}

/** 调试用：一眼看全语气与长度怎么落的。 */
export function toneDebug(dims, prefs = readToneTiers()) {
  const eff = effectiveDesire(dims);
  const band = bandOf(eff);
  const tier = resolveToneTier(eff, prefs);
  return {
    eff,
    band: { id: band.id, label: band.label, min: band.min },
    tier: tier ? { id: tier.id, tone: tier.tone } : null,
    prefs,
    line: toneLineOf(dims, prefs),
    style: styleOf(dims),
  };
}
