// 角色卡：她是谁、怎么叫你、什么脾气、一次说多少。
//
// 为什么单独一个模块：旧包把这些硬编码进 7 MB 的打包产物里，改一句人设要重打整包。
// 新壳把它抽成配置，改完立刻生效（下一次发送就用新 prompt）。
//
// 存 localStorage 而不是 vault：这里没有密钥，只有称呼和脾气。
// 用 vault 反而要多一次原生往返，且导入导出时会被当成敏感数据。
import { s } from '../strings.zh.js';
import { RELATIONSHIPS } from './companion.js';
import { buildLoreBlock } from './lore.js';

const KEY = 'ellen.persona.v1';

/** 脾气。id 只用于存取，label 走 strings，别把中文写进存储。 */
export const TONES = ['soft', 'quiet', 'teasing', 'clingy', 'cool'];

/** 一次回多少。太长的回复在手机气泡里读着累，默认短句。 */
export const LENGTHS = ['short', 'normal', 'long'];

export const DEFAULT_PERSONA = {
  name: '艾莲',
  callMe: '', // 她怎么叫你；空 = 用「你」
  tone: 'soft',
  length: 'short',
  note: '', // 用户自己补的一句
};

export function readPersona() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_PERSONA };
    const parsed = JSON.parse(raw);
    const merged = { ...DEFAULT_PERSONA, ...parsed };
    if (!TONES.includes(merged.tone)) merged.tone = DEFAULT_PERSONA.tone;
    if (!LENGTHS.includes(merged.length)) merged.length = DEFAULT_PERSONA.length;
    return merged;
  } catch {
    return { ...DEFAULT_PERSONA };
  }
}

export function writePersona(patch) {
  const merged = { ...readPersona(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(merged));
  } catch (err) {
    console.warn('[persona] 存不下', err);
  }
  return merged;
}

export function resetPersona() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* 清不掉就用默认值 */
  }
  return { ...DEFAULT_PERSONA };
}

const TONE_LINES = {
  soft: '语气温柔，语速慢一点，句子短，别用感叹号堆情绪。',
  quiet: '话不多，安静，偶尔一两句，不解释自己为什么少话。',
  teasing: '爱逗他，会拿他说过的话开小玩笑，但不刻薄。',
  clingy: '黏人，会在意他在不在，会撒娇，但不闹。',
  cool: '冷静克制，讲道理，偶尔露一点心软。',
};

const LENGTH_LINES = {
  short: '一次只说一到两句，说完就停，不要补解释。',
  normal: '一次说两三句，够把意思说清楚就行。',
  long: '可以多说几句，但不要写成一段作文，最多四句。',
};

/**
 * 拼 system prompt。
 *
 * 规则写死的那几条都是有来由的：
 *   - 不复述、不总结：模型爱写「你说你在加班，我理解你…」，读着像客服。
 *   - 不用列表和小标题：手机上气泡里出现 `- ` 和 `##` 很出戏。
 *   - 强调用 **粗体**：richtext.js 渲染粗体为粉色（不是字重，字形只有 400）。
 */
export function buildSystemPrompt({ persona, relationship, lore, mood, bond, now = Date.now() } = {}) {
  const p = { ...DEFAULT_PERSONA, ...(persona || {}) };
  const relId = (relationship && relationship.id) || 'lover';
  const rel = RELATIONSHIPS.find((r) => r.id === relId) || RELATIONSHIPS[0];
  const callMe = String(p.callMe || '').trim();

  const lines = [
    `你是${p.name}。你和${callMe || '他'}在一起，是${rel.label}关系。`,
    TONE_LINES[p.tone] || TONE_LINES.soft,
    LENGTH_LINES[p.length] || LENGTH_LINES.short,
    '说话像真人：不用敬语，不说「作为一个 AI」，不叫对方「用户」。',
    '不要复述他说过的话，不要总结这段对话，不要问他「还有什么想聊的」。',
    '需要强调时只用 **粗体**，不要用列表、标题、分割线。',
    '偶尔主动关心他一句（吃饭、睡觉、累不累），但不要每句都问。',
  ];

  // lore 段（角色卡事实）：可选。不传就整段跳过，输出与加这个功能之前逐字节一致。
  // 为什么插在第 1 行之后、语气规则之前：先给「你是谁、这些是事实」，后面的
  // 「简短 / 不要列表」才落在具体这个人身上；事实在前也更不容易被当成设定说明书。
  // lore 可以直接传拼好的字符串（热路径最省），也可以传 { query } 让它现场按这句话题命中世界书。
  let loreBlock = '';
  if (typeof lore === 'string') loreBlock = lore.trim();
  else if (lore && typeof lore === 'object') {
    loreBlock = buildLoreBlock({
      persona: p,
      relationship: rel,
      query: lore.query || '',
      cardId: lore.cardId,
      rand: lore.rand || Math.random,
      now,
    });
  }
  if (loreBlock) lines.splice(1, 0, loreBlock);

  // mood / bond 只在签名上占位：心情措辞归 mood 产出方、亲密度措辞归 bond.js，
  // 这个函数只加事实不加语气，两边同时拼会把同一句「累不累」写出两个版本。
  void mood; void bond;

  if (callMe) lines.push(`叫他的时候用「${callMe}」。`);
  const note = String(p.note || '').trim();
  if (note) lines.push(`还要记住这些设定：${note}`);

  const hour = new Date(now).getHours();
  if (hour >= 23 || hour < 6) lines.push('现在是深夜，说话轻一点，劝他早点睡但别唠叨。');
  else if (hour >= 6 && hour < 9) lines.push('现在是早上，可以问一句昨晚睡得怎么样。');

  return lines.join('\n');
}

/** 给设置页用的一句话摘要。 */
export function describePersona(p = readPersona()) {
  const tone = s(`settings.tone_${p.tone}`);
  const len = s(`settings.length_${p.length}`);
  return `${p.name} · ${tone} · ${len}`;
}
