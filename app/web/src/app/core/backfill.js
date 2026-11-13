// 历史补算：把「以前就有的聊天记录」折成亲密度，并把走过却没写信的每个档位补一封。
//
// 老大原话（2026-11-13）：「以前有的聊天记录如果能读到的话补发信和加好感度，每个阶段都有信，
// 最少一千五百字」。这段话拆成两件事，正好是本文件的两个阶段：
//   ① 加好感度 → `planFromHistory()` 把全部历史消息按 bond.js 同一套规则重放一遍，算出点数/档位；
//   ② 补发信   → `letterGaps()` 列出「已经走过、但 `bond.letters` 里没有」的档位，
//                再 `writeGaps()` 逐档写一封（字数下限由 bond.STAGES[].minChars 决定，相识~亲近 1500、恋人 3000）。
//
// 为什么单独成文件而不是塞进 bond.js：bond 只管规则，不碰网络也不碰别的模块；
// 补算要读消息库、要动 affect、要发模型请求，这些都不该压进最底层那个文件。
//
// 幂等：同一个档位写过就跳过（读的是 `bond.letters`），重复点按钮不会把同一档写第二封；
// 想重写就传 `force: true`，也只影响当前档。
import {
  STAGES,
  MIN_STAGE_MESSAGES,
  POINTS_PER_MESSAGE,
  FIRST_OF_DAY_POINTS,
  dayKey,
  stageIndexOf,
  snapshot as bondSnapshot,
  seedFromHistory,
} from './bond.js';
import { listLatest } from './store/library.js';
import { putMeta } from './store/records.js';
import { readCheckin, META_KEY as CHECKIN_KEY, normalizeState as normalizeCheckin } from './checkin.js';
import { loadAffect, saveAffect, snapshot as affectSnapshot } from './affect.js';
import { composeLetter } from './letter.js';

/** 档位 → 好感度下限。要不要改这套数，只改这张表。 */
export const AFFECTION_FLOOR = {
  acquainted: 40,
  familiar: 55,
  trusted: 68,
  close: 80,
  lover: 92,
};

/**
 * 读全库消息（所有会话、所有版本的最新一版），按时间正序。
 * 撤回的不算（`recalled` 已经在 value 里标了），pending 的更不算。
 * @returns {Promise<Array<{at:number, role:string}>>}
 */
export async function readHistory() {
  const rows = await listLatest('message', { limit: 0 });
  const out = [];
  for (const r of rows) {
    const v = (r && r.value) || {};
    if (!v || v.pending || v.recalled) continue;
    const at = Number(v.createdAt || r.at || r.createdAt) || 0;
    if (!at) continue;
    out.push({ at, role: v.role === 'user' ? 'user' : 'assistant' });
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}

/**
 * 纯函数：把一串消息重放成亲密度计划。和 `bond.touchMessage` 同一套算法
 * （每条 +1、当天第一条按 3 算；升档要同时满足点数门槛和本阶段 ≥30 条）。
 * @param {Array<{at:number}>} messages
 * @returns {{messages:number, days:number, points:number, stage:string, stageIndex:number, stageSince:number, stageMessages:number, lastDay:string, from:number, to:number}}
 */
export function replay(messages = []) {
  const list = (messages || []).filter((m) => m && Number(m.at) > 0).sort((a, b) => a.at - b.at);
  let points = 0;
  let lastDay = '';
  let stageIndex = 0;
  let stageSince = list.length ? list[0].at : 0;
  let stageMessages = 0;
  let days = 0;

  for (const m of list) {
    const d = dayKey(m.at);
    if (d !== lastDay) days += 1;
    points += d === lastDay ? POINTS_PER_MESSAGE : FIRST_OF_DAY_POINTS;
    lastDay = d;
    stageMessages += 1;
    // 一次可能连升几档 —— 和 bond.advance 一样用 while，不能只判断一次
    while (stageIndex < STAGES.length - 1) {
      const info = STAGES[stageIndex];
      if (points < info.threshold) break;
      if (stageMessages < MIN_STAGE_MESSAGES) break;
      stageIndex += 1;
      stageSince = m.at;
      stageMessages = 0;
    }
  }

  return {
    messages: list.length,
    days,
    points,
    stage: STAGES[stageIndex].id,
    stageIndex,
    stageSince,
    stageMessages,
    lastDay,
    from: list.length ? list[0].at : 0,
    to: list.length ? list[list.length - 1].at : 0,
  };
}

/**
 * 已经走过、但还没写过信的档位（从早到晚）。
 * @param {object} bond `bond.snapshot()` 的结果
 * @param {number} [upto] 只看到第几档（默认按 bond 当前档）
 * @returns {Array<{id:string,label:string,minChars:number}>}
 */
export function letterGaps(bond, upto = null) {
  const letters = (bond && bond.letters) || {};
  const cur = upto == null ? stageIndexOf(bond && bond.stage) : Math.max(0, Math.min(STAGES.length - 1, upto));
  return STAGES.slice(0, cur + 1)
    .filter((s) => !letters[s.id])
    .map((s) => ({ id: s.id, label: s.label, minChars: s.minChars }));
}

/**
 * 现在该做什么：读历史 → 重放 → 和当前存档比，给出「要不要补算」和「缺哪几封信」。
 * 纯读，不写库（除了 bond/affect 的读取本身）。
 * @returns {Promise<{history:{messages:number,days:number,from:number,to:number}, plan:object, current:object, pointsNow:number, gaps:Array, affectionNow:number, affectionFloor:number, needsPoints:boolean}>}
 */
/**
 * 纯函数：把「哪天说过话」折成签到统计。
 * 为什么拿聊天日回填签到：迁移过来的老数据只有消息，签到表是空的，
 * 相处页就永远显示「连续 0 天」。只补统计（天数 / 连击 / 最长），不动 lastDay 以外的任何东西，
 * 也不会替用户「签今天」——今天要不要来，还是他自己点。
 * @param {string[]} days 形如 `2026-11-12`，可以重复、可以不排序
 */
export function checkinPlan(days = []) {
  const uniq = [...new Set((days || []).filter((d) => typeof d === 'string' && d))].sort();
  if (!uniq.length) return { days: 0, streak: 0, best: 0, lastDay: '' };
  const toNum = (k) => {
    const [y, m, d] = k.split('-').map((n) => Number(n));
    return Date.UTC(y, (m || 1) - 1, d || 1) / 86400000;
  };
  let best = 1;
  let run = 1;
  for (let i = 1; i < uniq.length; i += 1) {
    if (toNum(uniq[i]) - toNum(uniq[i - 1]) === 1) run += 1;
    else run = 1;
    if (run > best) best = run;
  }
  // 结尾那串 = 连击（不管结尾是不是今天：断了就是 0，这里只报「到最后一个说话日为止」）
  let streak = 1;
  for (let i = uniq.length - 1; i > 0; i -= 1) {
    if (toNum(uniq[i]) - toNum(uniq[i - 1]) === 1) streak += 1;
    else break;
  }
  return { days: uniq.length, streak, best: Math.max(best, streak), lastDay: uniq[uniq.length - 1] };
}

/** 落盘签到统计：只升不降，且不替用户签到（lastDay 只往前挪）。 */
export async function applyCheckin(plan, { at = Date.now() } = {}) {
  if (!plan || !plan.days) return { applied: false };
  const before = normalizeCheckin(await readCheckin());
  const next = {
    ...before,
    days: Math.max(before.days, plan.days),
    streak: Math.max(before.streak, plan.streak),
    best: Math.max(before.best, plan.best),
    lastDay: before.lastDay && before.lastDay > plan.lastDay ? before.lastDay : plan.lastDay,
    updatedAt: at,
  };
  await putMeta(CHECKIN_KEY, next);
  return { applied: true, state: next };
}

export async function planFromHistory() {
  const history = await readHistory();
  const plan = replay(history);
  const bond = await bondSnapshot();
  const affect = await loadAffect({ persist: false });
  const dims = (affectSnapshot(affect) || {}).dims || {};
  const affectionNow = Number(dims.affection) || 0;
  const affectionFloor = AFFECTION_FLOOR[plan.stage] || 0;
  const gaps = letterGaps({ ...bond, stage: plan.stage }, plan.stageIndex);
  const checkinPlanned = checkinPlan(history.map((m) => dayKey(m.at)));
  const checkinNow = normalizeCheckin(await readCheckin());

  return {
    history: { messages: plan.messages, days: plan.days, from: plan.from, to: plan.to },
    plan,
    current: { points: bond.points, stage: bond.stage, letters: { ...(bond.letters || {}) } },
    pointsNow: Number(bond.points) || 0,
    gaps,
    affectionNow,
    affectionFloor,
    needsPoints: plan.points > (Number(bond.points) || 0),
    checkin: { plan: checkinPlanned, now: checkinNow, needs: checkinPlanned.days > checkinNow.days },
  };
}

/**
 * 落盘：亲密度按计划重写、好感度抬到档位下限。**只升不降** ——
 * 已经在恋人档的人，不会因为历史消息算出来少一点就被打回去。
 * @param {object} plan `replay()` 的返回
 * @param {{at?:number}} [opts]
 */
export async function applyPlan(plan, { at = Date.now() } = {}) {
  if (!plan || !plan.points) return { applied: false };
  const before = await bondSnapshot();
  const points = Math.max(Number(before.points) || 0, Number(plan.points) || 0);
  const idx = Math.max(stageIndexOf(before.stage), stageIndexOf(plan.stage));
  const stage = STAGES[idx].id;

  const bond = await seedFromHistory({
    points,
    stage,
    stageSince: idx > stageIndexOf(before.stage) ? Number(plan.stageSince) || at : Number(before.stageSince) || 0,
    stageMessages: Number(plan.stageMessages) || 0,
    lastDay: plan.lastDay || before.lastDay || '',
  });

  const floor = AFFECTION_FLOOR[stage] || 0;
  const affect = await loadAffect({ persist: false });
  const snap = affectSnapshot(affect) || {};
  const dims = { ...(snap.dims || {}) };
  const raised = floor > (Number(dims.affection) || 0);
  if (raised) {
    dims.affection = floor;
    await saveAffect({ state: { ...affect, dims } });
  }

  return { applied: true, bond, affection: raised ? floor : Number(dims.affection) || 0, raisedAffection: raised };
}

/**
 * 补写信：按档位从早到晚，一档一封。写一封就标一封（`letter.writeLetter` 内部会
 * `markLetterWritten`），所以中途断了再点一次，只会接着写没写的那些。
 *
 * @param {object} p
 * @param {{endpoint:string,apiKey:string,model:string}} p.config
 * @param {(d:{stage:string,index:number,total:number,label:string,text?:string,chars?:number,done?:boolean})=>void} [p.onProgress]
 * @param {AbortSignal} [p.signal]
 * @param {boolean} [p.force] 已写过的档位也重写（默认跳过）
 * @returns {Promise<{written:Array<{stage:string,chars:number,short:boolean}>, skipped:Array<string>, failed:Array<{stage:string,code:string}>}>}
 */
export async function writeGaps({ config, persona = null, onProgress = null, signal = null, force = false } = {}) {
  const bond = await bondSnapshot();
  const cur = stageIndexOf(bond.stage);
  const gaps = force ? STAGES.slice(0, cur + 1).map((s) => ({ id: s.id, label: s.label })) : letterGaps(bond, cur);
  const written = [];
  const skipped = [];
  const failed = [];

  for (let i = 0; i < gaps.length; i += 1) {
    const gap = gaps[i];
    if (signal && signal.aborted) break;
    try {
      if (typeof onProgress === 'function') {
        onProgress({ stage: gap.id, index: i, total: gaps.length, label: gap.label, done: false });
      }
      const res = await composeLetter({
        config,
        persona,
        stage: gap.id,
        signal,
        onDelta: (d) => {
          if (typeof onProgress === 'function') {
            onProgress({ stage: gap.id, index: i, total: gaps.length, label: gap.label, chars: d.chars, text: d.text });
          }
        },
      });
      written.push({ stage: gap.id, chars: res.chars, short: res.short });
      if (typeof onProgress === 'function') {
        onProgress({ stage: gap.id, index: i, total: gaps.length, label: gap.label, chars: res.chars, done: true });
      }
    } catch (err) {
      const code = (err && err.code) || 'WRITE_FAILED';
      if (code === 'ALREADY_WRITTEN') skipped.push(gap.id);
      else failed.push({ stage: gap.id, code });
      // 一封失败不该拦着后面的：继续写下一档
    }
  }

  return { written, skipped, failed };
}
