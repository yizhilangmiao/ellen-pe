// 角色卡清单：谁存在、从哪来、叫什么。
//
// 为什么要有这一层：
//   以前 assets/lore/index.js 里直接写死 `CARD_IDS = ['ellen', 'ellen-lover']`，
//   加第三个角色要改代码、还要记得同步 core/lore.js 里三处 `CARD_IDS.includes(...)`。
//   这一层把「有哪些卡」变成数据，index.js 只负责把它们装进注册表。
//
// 两个来源，内置的只读、用户的优先：
//   · BUILT_IN —— 随包打进 bundle 的卡（vite 静态 import，运行时零 IO）
//   · 用户导入 —— 存 localStorage（`ellen.lore.cards.v1`），形状和内置卡完全一致
//
// 为什么用户卡也进 localStorage 而不是文件目录：
//   手机版可写目录只有 filesDir，读它必须过原生 bridge；而角色卡总量压在 3 KB 段内、
//   单卡数据不到 10 KB，塞 localStorage 省掉一次原生往返，也不会因为清理缓存失效。
//   （将来导入 .ellenpack 里的 lore/ 目录时，由导入流程把内容转成同一形状写进来。）
import ellen from './ellen.js';
import ellenLover from './ellen-lover.js';

/** 内置卡。顺序即设置页展示顺序：原作向在前，恋人卡在后（老大默认用原作向）。 */
export const BUILT_IN_LORE = [
  { id: 'ellen', card: ellen, builtIn: true },
  { id: 'ellen-lover', card: ellenLover, builtIn: true },
];

/** 用户导入的卡存放处。 */
export const USER_LORE_KEY = 'ellen.lore.cards.v1';

/** id 规则和导入包里的 cardId 校验保持一致，别让两条通道的 id 形状分叉。 */
export const LORE_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * 校验一张卡够不够用。
 * 只认「能进 prompt 的最小集合」：core 是常驻事实，缺了这张卡就是空的；
 * world / worldbook / samples 都可以空着（buildLoreBlock 会跳过）。
 */
export function isValidCard(card) {
  if (!card || typeof card !== 'object') return false;
  const core = card.core;
  if (!Array.isArray(core) || !core.length) return false;
  if (!core.every((line) => typeof line === 'string' && line.trim())) return false;
  if (card.world != null && !Array.isArray(card.world)) return false;
  if (card.worldbook != null && !Array.isArray(card.worldbook)) return false;
  if (card.samples != null && !Array.isArray(card.samples)) return false;
  return true;
}

/** 读用户导入的卡。任何一条坏数据只丢它自己，不影响其它卡、更不影响内置卡。 */
export function readUserCards() {
  let raw = null;
  try {
    raw = localStorage.getItem(USER_LORE_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn('[lore] 用户角色卡清单不是合法 JSON，按没有处理');
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out = [];
  const seen = new Set(BUILT_IN_LORE.map((it) => it.id));
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const { id, card } = item;
    if (typeof id !== 'string' || !LORE_ID_RE.test(id)) {
      console.warn('[lore] 用户角色卡 id 不合法，跳过：', id);
      continue;
    }
    if (seen.has(id)) {
      console.warn('[lore] 用户角色卡与已有 id 撞车，跳过：', id);
      continue;
    }
    if (!isValidCard(card)) {
      console.warn('[lore] 用户角色卡内容不完整，跳过：', id);
      continue;
    }
    seen.add(id);
    out.push({ id, card, builtIn: false });
  }
  return out;
}

/** 写用户卡（导入流程用）。只写用户那部分，内置卡永远不落盘。 */
export function writeUserCards(list) {
  const clean = (Array.isArray(list) ? list : [])
    .filter((it) => it && typeof it.id === 'string' && LORE_ID_RE.test(it.id) && isValidCard(it.card))
    .map((it) => ({ id: it.id, card: it.card }));
  try {
    localStorage.setItem(USER_LORE_KEY, JSON.stringify(clean));
    return clean;
  } catch (err) {
    console.warn('[lore] 写用户角色卡失败（多半是 localStorage 满了）', err);
    return [];
  }
}

/** 加一张用户卡（同 id 覆盖，内置 id 拒绝）。 */
export function addUserCard(id, card) {
  const list = readUserCards().map((it) => ({ id: it.id, card: it.card }));
  const idx = list.findIndex((it) => it.id === id);
  if (idx >= 0) list[idx] = { id, card };
  else list.push({ id, card });
  return writeUserCards(list);
}

/** 删一张用户卡。内置卡删不掉，返回 false 让调用方去提示。 */
export function removeUserCard(id) {
  if (BUILT_IN_LORE.some((it) => it.id === id)) return false;
  const list = readUserCards().filter((it) => it.id !== id).map((it) => ({ id: it.id, card: it.card }));
  writeUserCards(list);
  return true;
}
