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
import { phaseLine } from '../assets/lore/day.js';

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

// 长度：**唯一一处**。有上限、可数，别用「两三句」这种模糊说法。
//
// 为什么改成可数：原来三处同时定句数（这里「一到两句」、affect-events 的 STYLE_LINE
// 「2~4 句」、tone.js styleOf 的「两三句把意思说清楚」），模型收到互相矛盾的量就挑最宽的那个，
// 于是设置里选「短」照样一次说三句 —— 这个设置等于没生效，而且每条回复长度都一样长，
// 读起来像同一个人按同一个模板在说话。长度只留这一处，其余两处只说姿态和动作。
//
// 上限用字数是刻意的：句数不好数（一个逗号算不算一句？），字数模型能自己数。
const LENGTH_LINES = {
  short: '一次只说一句，20 字以内，说完就停，不要补解释。',
  normal: '一次一到两句，一共 45 字以内，够把意思说清楚就行。',
  long: '可以三四句，一共 80 字以内，但不要写成一段作文。',
};

/**
 * 正负对照：用「他这样说 → 你会这样答」代替再加一条禁令。
 * 为什么：prompt 里已经有一堆「不要」，模型读多了会往「礼貌、完整、面面俱到」那边拐；
 * 例子给的是手感，比第九条「不要」有用。三条足够，多了会把气泡带成一个模板。
 */
const STYLE_EXAMPLES = [
  '他喊累，别答「听起来你很辛苦，要注意休息哦」，你会说「累了就躺会儿。要不要我陪你说说话」。',
  '他要你拿主意，别答「建议你从几个方面考虑」，你会说「你自己定。定了我帮你收尾」。',
  '他问你还好吗，别答「我很好，谢谢关心，你呢」，你会说「还行。你今天不太一样」。',
];

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
    // 四条禁令合成一条：原来分开写，模型读到的是四句互不相干的否定，最容易读成
    // 「什么都别做」，反而又正又板。合成后语义不变，省下的行留给下面的正例。
    '说人话：不用敬语、不说「作为一个 AI」、不叫对方「用户」、不复述他的话、'
      + '不总结这段对话、不问「还想聊什么」；强调只用 **粗体**，不用列表和标题。',
    '偶尔问一句吃饭睡觉，但别每句都问。',
    ...STYLE_EXAMPLES,
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

  // 钟点：全天都给，不只给深夜和早上。
  // 原来只写 23–6 和 6–9 两段，白天 prompt 里一个字都不提现在几点 → 模型只能从
  // 记忆和样本里找「艾莲大概会说什么」，于是下午三点也能冒出一句「时候不早啦快睡」。
  // 给了具体时刻之后，「现在几点」是事实而不是猜测；真说了对不上的话，
  // main.js 那边还有一道 time-guard 会拦（见 core/time-guard.js）。
  const when = new Date(now);
  const hour = when.getHours();
  const minute = when.getMinutes();
  const clock = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  const dayName = '日一二三四五六'[when.getDay()];
  const slot = hour >= 23 || hour < 6
    ? '深夜'
    : hour < 9
      ? '早上'
      : hour < 12
        ? '上午'
        : hour < 14
          ? '中午'
          : hour < 18
            ? '下午'
            : hour < 21
              ? '傍晚'
              : '晚上';
  lines.push(`现在是周${dayName}${slot}，${clock}。`);
  // 她自己的时间线：只说「这会儿大概在做什么」，不讲情绪（情绪归 mood，语气归 tone）。
  lines.push(phaseLine(now));
  if (hour >= 23 || hour < 6) lines.push('这个点他在熬夜，说话轻一点，劝他早点睡但别唠叨。');
  else if (hour < 9) lines.push('这个点刚起，可以问一句昨晚睡得怎么样。');
  else lines.push('不要提睡觉、晚安、早安这类只属于深夜或清晨的话，除非他说起。');

  return lines.join('\n');
}

/** 给设置页用的一句话摘要。 */
export function describePersona(p = readPersona()) {
  const tone = s(`settings.tone_${p.tone}`);
  const len = s(`settings.length_${p.length}`);
  return `${p.name} · ${tone} · ${len}`;
}
