// 她回表情（2026-11-12）
//
// 为什么不让模型来挑：挑一张图不该花一次请求、等两秒。这里的判断足够简单也更稳。
// 规则（可解释，也能被测试覆盖）：
//   · 你发表情过来，她有一半多一点的概率也回一张 —— 每次都回显得吵；
//   · 你发的是「生气 / 委屈」这类，她更可能回同一类（不是"我懂你"，是"我也这样"）；
//   · 其余时候从「开心 / 比心 / 笔芯 / 加油 / 晚安 / 敬礼」里挑 —— 回一张"看着你笑"的脸最安全。
// 全部只读收藏的 12 张（STICKER_FAVORITES）：225 张里挑太随机，会挑出她根本不会用的图。

import { STICKER_FAVORITES, stickerById } from '../assets/stickers.js';
import { pickCustomForSlot } from './sticker-library.js';

/** 回表情的概率。0.55：一半多一点，够有存在感，又不至于每句都贴脸。 */
export const STICKER_REPLY_CHANCE = 0.55;

/** 回同一类表情的概率（只在对方发的表情有对应 slot 时生效）。 */
export const SAME_SLOT_CHANCE = 0.3;

/** 这些 slot 用在任何语境都不冒犯人。 */
export const SAFE_SLOTS = ['开心', '比心', '笔芯', '加油', '晚安', '敬礼'];

/** 同一类就照回去的 slot（情绪对得上才叫"接住了"）。 */
export const ECHO_SLOTS = ['生气', '委屈', '震惊', '问号', '无语', '摆烂'];

/**
 * 好感分界（E4）：高走 SAFE、低走 ECHO。
 * 为什么 55 / 30：SD 的日常好感是 40，往上 55 才算「熟到敢比心」，往下 30 才是
 * 「心里有事不想笑」。中间那段保持原行为 —— 关系没定性的时候，别硬替她表态。
 */
export const AFFECTION_WARM_MIN = 55;
export const AFFECTION_COLD_MAX = 30;

/** 这一档好感用哪组 slot（给界面/测试看）。 */
export function poolKindOf(affection) {
  const a = Number(affection);
  if (Number.isFinite(a) && a >= AFFECTION_WARM_MIN) return 'safe';
  if (Number.isFinite(a) && a < AFFECTION_COLD_MAX) return 'echo';
  return 'mixed';
}

/** 收藏里这一张的 slot（不在收藏里返回空串）。 */
export function slotOf(stickerId) {
  const hit = STICKER_FAVORITES.find((f) => f.id === stickerId);
  return hit ? hit.slot : '';
}

/**
 * 要不要回、回哪一张。
 * @param {{incomingSlot?:string, roll?:number, pick?:number, affection?:number}} [opts]
 *   roll = 要不要回（0~1，测试时传定值）；pick = 池子里取第几张（0~1，同样为了可测）
 *   affection = 好感（0~100）。不传 = 旧行为（谁在场挑谁），传了才按关系分池。
 * @returns {{id:string,file:string,slot:string,label:string}|null} 不回就 null
 */
export function pickStickerReply({ incomingSlot = '', roll = Math.random(), pick = Math.random(), affection } = {}) {
  if (!STICKER_FAVORITES.length) return null;
  if (!(roll < STICKER_REPLY_CHANCE)) return null;

  const kind = poolKindOf(affection);
  const echoOk = incomingSlot && ECHO_SLOTS.indexOf(incomingSlot) >= 0;
  let pool = [];
  // 高好感不照回坏情绪：关系好的时候她不会跟着你一起生气，会挑一张把气氛拉回来的
  // （比心/笔芯/晚安）。这就是 SAFE / ECHO 两组的分工，不是随机差异。
  if (echoOk && pick < SAME_SLOT_CHANCE && kind !== 'safe') {
    pool = STICKER_FAVORITES.filter((f) => f.slot === incomingSlot);
  }
  if (!pool.length && kind === 'safe') pool = STICKER_FAVORITES.filter((f) => SAFE_SLOTS.indexOf(f.slot) >= 0);
  // 低好感只走 ECHO 组：这时候贴一张比心很奇怪，她会挑生气/委屈/无语/摆烂
  if (!pool.length && kind === 'echo') pool = STICKER_FAVORITES.filter((f) => ECHO_SLOTS.indexOf(f.slot) >= 0);
  if (!pool.length) pool = STICKER_FAVORITES.filter((f) => SAFE_SLOTS.indexOf(f.slot) >= 0);
  if (!pool.length) pool = STICKER_FAVORITES;

  // 用户自己导入的表情并进池尾：她也会用「他给的那张」。
  // 放末尾而不是最前 —— 228 张包内素材继续占主流，导入的表情是加分不是主角。
  // pickCustomForSlot 不传 pick，各自随机；空表返回 null，行为与加之前完全一致。
  if (pickCustomForSlot) {
    const custom = pickCustomForSlot(incomingSlot);
    if (custom) pool = pool.concat([custom]);
  }

  const idx = Math.min(pool.length - 1, Math.max(0, Math.floor(pick * pool.length)));
  const chosen = pool[idx];
  const sticker = stickerById(chosen.id) || chosen;
  return {
    id: chosen.id,
    file: chosen.file || sticker.file || '',
    slot: chosen.slot || '',
    label: chosen.label || sticker.label || '',
  };
}

/** 回表情前等多久（毫秒）：太快像机器人，太慢像没看见。 */
export function replyDelay(rand = Math.random()) {
  return Math.round(1100 + rand * 1200);
}
