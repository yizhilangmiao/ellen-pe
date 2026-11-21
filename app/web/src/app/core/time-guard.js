/**
 * 时间一致性守卫（time guard）。
 *
 * 干什么：她说完一句话，检查里面有没有「只属于某个时段」的话——下午三点说
 * 「时候不早啦，快睡吧」就是典型的错。命中且时段不对，把那一句删掉再发。
 *
 * 为什么用「删句」而不是「重写」：重写要再调一次模型，延迟多几秒、token 多一倍，
 * 而且用户看到的是已经流式打出来的字，重写还得把气泡内容换掉——体验上更糟。
 * 删掉一句的代价是这句回复短了一点，但绝不会说出不合时宜的话。
 *
 * 为什么不用关键词硬拦整条：一句「晚安，我先去忙了，你早点睡」删了整条就没人味了，
 * 按句删只损失真正错的那部分。
 *
 * 这里只做「明显矛盾」的判断，不追求语义精确：宁可漏，不要误删。
 */

/** 时段窗口：左闭右开，跨夜用 [21, 4] 这种写法（21,22,23,0,1,2,3 点都算）。 */
export const TIME_RULES = [
  {
    id: 'night',
    words: [
      '晚安', '睡了', '睡觉', '睡吧', '快睡', '早点睡', '早点休息', '该睡了', '该休息',
      '不早了', '这么晚', '夜深了', '困了', '熬夜', '别熬', '快歇',
    ],
    // 午觉/午休/眯一会 这类白天说的话，命中 night 词也要放过
    except: ['午觉', '午休', '眯', '补觉'],
    from: 21,
    to: 4,
  },
  {
    id: 'morning',
    words: ['早安', '早上好', '起床', '昨晚睡得', '早饭'],
    except: [],
    from: 5,
    to: 10,
  },
  {
    id: 'noon',
    words: ['午饭', '中午吃', '午休', '中午睡'],
    except: [],
    from: 11,
    to: 14,
  },
  {
    id: 'evening',
    words: ['晚饭', '下班', '收工'],
    except: [],
    from: 17,
    to: 21,
  },
];

function hourOf(now) {
  return new Date(now).getHours();
}

/** 时段判断：from < to 是同日窗口，from > to 是跨夜窗口。 */
export function inWindow(hour, from, to) {
  if (from === to) return false;
  if (from < to) return hour >= from && hour < to;
  return hour >= from || hour < to;
}

/**
 * 找出这句话里不合时宜的词。
 * @param {string} text 回复正文
 * @param {number} now  当前时间戳（ms），默认现在
 * @returns {{hits: Array<{rule: string, word: string, hour: number}>, ok: boolean}}
 */
export function timeHits(text, now = Date.now()) {
  const s = String(text || '');
  const hour = hourOf(now);
  const hits = [];
  if (!s) return { hits, ok: true };
  for (const rule of TIME_RULES) {
    if (inWindow(hour, rule.from, rule.to)) continue; // 这个时段本来就是对的
    if (rule.except.some((w) => s.includes(w))) continue; // 「睡个午觉」这类放过
    for (const w of rule.words) {
      if (s.includes(w)) hits.push({ rule: rule.id, word: w, hour });
    }
  }
  return { hits, ok: hits.length === 0 };
}

/** 按句子切，保留标点（拆条和朗读都按句走，别把句子拼坏）。 */
const SENTENCE_SPLIT = /(?<=[。！？!?\n])/;

/**
 * 守卫一条回复：删掉不合时宜的句子。
 * @returns {{text: string, removed: string[], changed: boolean}}
 *   removed 是删掉的原文，方便日志里看清拦了什么
 */
export function guardReply(text, now = Date.now()) {
  const s = String(text || '');
  if (!s.trim()) return { text: s, removed: [], changed: false };

  const sentences = s.split(SENTENCE_SPLIT);
  const dayHour = hourOf(now);
  const kept = [];
  const removed = [];

  for (const sentence of sentences) {
    if (!sentence.trim()) continue;
    const { ok } = timeHits(sentence, now);
    if (ok) {
      kept.push(sentence);
      continue;
    }
    // 整句都是一个时间断言（「晚安」「早上好呀」）→ 直接丢
    // 句子还带别的内容（「这么晚了还不睡，我先去忙了」）→ 也丢，
    //   因为这半句的判断前提就是错的，留着反而自相矛盾
    removed.push(sentence.trim());
  }

  if (!removed.length) return { text: s, removed: [], changed: false };

  let out = kept.join('').trim();
  if (!out) {
    // 全删空了：不能发个空泡。挑一句跟时段无关的兜底，别用「晚安」这种又踩坑的词。
    out = dayHour >= 23 || dayHour < 6 ? '我还在。' : '嗯，我在。';
  }
  return { text: out, removed, changed: true };
}

/**
 * 给日志用的一句话摘要。别把整段回复打进来，只报拦了什么。
 */
export function describeHit(result) {
  if (!result || !result.changed) return '';
  return `time-guard 删了 ${result.removed.length} 句：${result.removed.join(' / ')}`;
}
