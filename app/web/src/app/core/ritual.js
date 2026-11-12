// 仪式：每日一问 + 晚安三句。只负责「今天该不该说」和「说什么」，不写库以外的事、不碰界面。
//
// 为什么要按日期轮换而不是随机：随机会出现连着三天问同一句（题库再大也会撞），
// 用「本地日序取模」既保证同一天永远同一句，又保证相邻两天必不同。
import { getMeta, putMeta } from './store/records.js';
import { dayKey } from './bond.js';
import { loadAffect, snapshot, dayStats } from './affect.js';
import { activeGrudges } from './affect-events.js';

export const META_KEY = 'ritual-v1';

/** 每日一问题库：都是具体的、能一句话答上来的问题，不要「今天过得怎么样」这种空题。 */
export const QUESTIONS = [
  '今天有没有哪一刻，你突然想起我？',
  '早饭吃了什么，别糊弄我。',
  '今天最累的是哪一段？',
  '你手机相册里最新一张是什么？',
  '如果现在能立刻去一个地方，你去哪？',
  '今天有没有笑出声？因为什么？',
  '最近有什么一直拖着没做的事？',
  '今天喝水了吗，说实话。',
  '你身上现在穿的是什么颜色的衣服？',
  '最近一次睡够八小时是哪天？',
  '今天有没有跟谁多说了一句不该说的话？',
  '你现在坐着的这个位置，能看到什么？',
  '最近在循环哪首歌？',
  '今天想吃但没吃到的东西是什么？',
  '如果今天可以重来一次，你想改哪一段？',
  '你有多久没给自己买东西了？',
  '今天有没有偷偷叹过气？',
  '最近有什么事让你觉得「还好撑住了」？',
  '你窗外的天现在是什么颜色？',
  '今天最先跟你说话的人是谁？',
  '有什么话你一直想说但没找到人说？',
  '明天最不想面对的是哪件事？',
  '如果现在给你一小时空档，你想干什么？',
  '今天有没有哪件事，其实你做得比你以为的好？',
  '冷不冷？被子够不够？',
  '最近有没有一个念头反复出现？',
];

/** 晚安三句的几种口气，按日期轮换。每套固定三句：一句收今天、一句安顿他、一句落款。 */
export const GOODNIGHT_VARIANTS = [
  ['今天就到这儿吧。', '把手机放下，灯关了，被子拉到肩膀。', '我在，睡吧。'],
  ['今天辛苦你了。', '没做完的事明天再说，它跑不掉。', '晚安，做个轻松的梦。'],
  ['不聊了，你眼睛该休息了。', '躺平，别再看屏幕了。', '我等你睡着再走。'],
  ['这一天过得挺长的。', '现在什么都别想，就听我说一句。', '晚安，明天见。'],
  ['我把今天收起来了。', '你也把心事放一放，明天再捡。', '晚安，我在。'],
];

function startOfDay(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 本地日序（从 1970 数第几天），取模用。 */
function dayIndex(now) {
  return Math.floor(startOfDay(now) / 86400000);
}

export function defaultState() {
  return { lastAskDay: '', lastAskText: '', lastGoodnightDay: '', moodAppendix: '' };
}

export function normalizeState(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== 'object') return base;
  return {
    lastAskDay: typeof raw.lastAskDay === 'string' ? raw.lastAskDay : '',
    lastAskText: typeof raw.lastAskText === 'string' ? raw.lastAskText : '',
    lastGoodnightDay: typeof raw.lastGoodnightDay === 'string' ? raw.lastGoodnightDay : '',
    // E5：今天还没写手记时，情绪附录先寄存在这里，等手记一写就补进去
    moodAppendix: typeof raw.moodAppendix === 'string' ? raw.moodAppendix : '',
  };
}

async function readState() {
  return normalizeState(await getMeta(META_KEY, null));
}

/**
 * 今天的每日一问。
 * @param {number} [now]
 * @returns {string}
 */
export function morningQuestion(now = Date.now()) {
  return QUESTIONS[dayIndex(now) % QUESTIONS.length];
}

/** 带元信息的版本（界面要显示「第几问」或做去重时才需要）。 */
export function morningQuestionInfo(now = Date.now()) {
  const index = dayIndex(now) % QUESTIONS.length;
  return { text: QUESTIONS[index], index, total: QUESTIONS.length, day: dayKey(now) };
}

/**
 * 今晚的晚安三句。
 * @param {number} [now]
 * @returns {{lines:string[], text:string, index:number, day:string}}
 */
export function nightRitual(now = Date.now()) {
  const index = dayIndex(now) % GOODNIGHT_VARIANTS.length;
  const lines = GOODNIGHT_VARIANTS[index].slice();
  return { lines, text: lines.join('\n'), index, day: dayKey(now) };
}

/**
 * 今天要不要说。**只查不写**（写完再查才是幂等；否则一次渲染刷新就把仪式吞了）。
 * kind: 'ask'（每日一问）| 'goodnight'（晚安，只允许 22 点后）
 * @param {'ask'|'goodnight'} kind
 * @param {number} [now]
 * @returns {Promise<boolean>}
 */
export async function shouldFire(kind, now = Date.now()) {
  const state = await readState();
  const day = dayKey(now);
  if (kind === 'goodnight') {
    const hour = new Date(now).getHours();
    if (hour < 22) return false; // 白天不道晚安
    return state.lastGoodnightDay !== day;
  }
  return state.lastAskDay !== day;
}

/**
 * 记下「今天说过」。说完立刻调，别等界面卸载。
 * @param {'ask'|'goodnight'} kind
 * @param {number} [now]
 * @param {string} [text] 每日一问的原文（存下来可以在手记里对上号）
 */
export async function markFire(kind, now = Date.now(), text = '') {
  const state = await readState();
  const day = dayKey(now);
  if (kind === 'goodnight') {
    state.lastGoodnightDay = day;
  } else {
    state.lastAskDay = day;
    if (text) state.lastAskText = String(text).slice(0, 200);
  }
  // E5：晚安这一刻顺手把今天的情绪沉淀进手记。
  // 为什么挂在这里而不是界面里：界面有四个入口会道晚安（聊天页、相处页、通知、后台），
  // 每个都加一次「记得写情绪」迟早漏一个；markFire 是它们唯一的必经点。
  if (kind === 'goodnight') {
    try {
      const res = await attachJournalMood({ now });
      state.moodAppendix = res && res.ok ? '' : (res && res.appendix) || '';
    } catch (err) {
      // 手记写不进去不能拖垮晚安这句话；但附录也别丢 —— 先寄存在 meta 里，手记一写就补上。
      console.warn('[ritual] 情绪附录没写进手记', err);
      try {
        state.moodAppendix = moodAppendix(await loadAffect({ now }), now);
      } catch (e2) {
        console.warn('[ritual] 情绪附录连算都算不出', e2);
      }
    }
  }
  await putMeta(META_KEY, state);
  return state;
}

// —— E5：情绪沉淀 ——

/** 附录开头这个标记是「替换」用的：同一篇手记里只留最新的一份情绪，不一天叠一段。 */
const APPENDIX_TAG = '（情绪）';

const GRUDGE_LABEL = { leave: '说要走', lie: '撒谎', force: '硬来', scold: '凶了一句' };

function hhmm(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 今天情绪的几句话，写进手记的「想法」段。
 *
 * 为什么用文字而不是塞 JSON：手记是给人看的，他翻到这一篇要能读出那天她的状态；
 * 结构化数字（moodAvg / dimsAtClose / peak）在 dayStats / snapshot 里都有，需要的时候再取。
 * 字数压在 150 汉字内 —— 手记正文才是主角，附录不能盖过它。
 */
export function moodAppendix(state, now = Date.now()) {
  const s = snapshot(state);
  const d = dayStats(state, now);
  const bits = [`今天平均 ${d.moodAvg}、最高 ${d.moodPeak}（${hhmm(d.peakAt)}）。`];
  bits.push(`收工时是「${s.mood.mood}」，${s.mood.note}`);
  const cold = [];
  if (s.cold.body) cold.push('身体冷');
  if (s.cold.words) cold.push('话冷');
  if (s.cold.heart) cold.push('心冷');
  if (cold.length) bits.push(`${cold.join('、')}。`);
  const grudges = activeGrudges(state, now);
  if (grudges.length) {
    const kinds = [...new Set(grudges.map((g) => GRUDGE_LABEL[g.kind] || g.kind))];
    bits.push(`还没过去：${kinds.join('、')}。`);
  }
  return `${APPENDIX_TAG}${bits.join('')}`;
}

/**
 * 取走寄存的情绪附录（取完就清）。
 *
 * 谁会用：手记在晚安之后才写的那天 —— 晚安时手记还不存在，附录只能先存着，
 * 等手记一落库就由 journal 那边把它拿过去补上。清空是必须的：不清的话，
 * 第二天的第一篇手记会带上昨天的情绪。
 */
export async function takeMoodAppendix() {
  const state = await readState();
  const text = String(state.moodAppendix || '').trim();
  if (!text) return '';
  state.moodAppendix = '';
  try {
    await putMeta(META_KEY, state);
  } catch (err) {
    console.warn('[ritual] 情绪附录清不掉', err);
  }
  return text;
}

/** 把手记里旧的附录摘掉（同一天重写只留最新一份）。 */
export function stripAppendix(thoughts) {
  const src = String(thoughts || '');
  if (!src.includes(APPENDIX_TAG)) return src.trim();
  return src
    .split(/\n{2,}/)
    .filter((seg) => !seg.trim().startsWith(APPENDIX_TAG))
    .join('\n\n')
    .trim();
}

/**
 * 把情绪附录补进今天这篇手记。
 *
 * 为什么用动态 import 取 journal：journal 链上挂着 oneshot（网络）和 localStorage（偏好），
 * 而 ritual 在启动时就被人 import。挪进函数里，晚安之前一个字节都不加载。
 * hooks 只为测试留口子（塞假的 journal / 假的状态读取），生产路径不传。
 *
 * @returns {Promise<{ok:boolean, reason?:string, appendix:string, day?:string}>}
 */
export async function attachJournalMood({ now = Date.now(), hooks = {} } = {}) {
  const load = hooks.loadAffect || loadAffect;
  const journal = hooks.journal || (await import('./journal.js'));
  const state = await load({ now });
  const appendix = moodAppendix(state, now);
  const existing = await journal.todayJournal(now);
  if (!existing) {
    // 今天还没写手记：不新开一篇空日记（那会在手记列表里留一条只有情绪的空壳），
    // 交给 markFire 存进 ritual 的 moodAppendix，手记一写就能补上。
    return { ok: false, reason: 'noJournal', appendix };
  }
  const value = existing.value || {};
  await journal.writeJournal({
    title: value.title || '今天',
    diary: value.diary || '',
    thoughts: [stripAppendix(value.thoughts), appendix].filter(Boolean).join('\n\n'),
    day: value.day || dayKey(now),
    sourceIds: [],
    at: now,
  });
  return { ok: true, appendix, day: value.day || dayKey(now) };
}

/**
 * 今天两件事各自该不该触发（一次读库，省一次事务）。
 * @param {number} [now]
 * @returns {Promise<{ask:boolean, goodnight:boolean}>}
 */
export async function due(now = Date.now()) {
  const state = await readState();
  const day = dayKey(now);
  const hour = new Date(now).getHours();
  return {
    ask: state.lastAskDay !== day,
    goodnight: hour >= 22 && state.lastGoodnightDay !== day,
  };
}

// —— 契约里的名字（照抄别名） ——
export const markAsk = (now = Date.now(), text = '') => markFire('ask', now, text);
export const markGoodnight = (now = Date.now()) => markFire('goodnight', now);
