// 角色卡注册表。
//
// 为什么在 assets/ 里而不是 core/：这里是数据（会随素材更新变），core/ 只放逻辑。
// 为什么用静态 import 而不是运行时 fetch：App 走 file:///android_asset/，fetch 会被 WebView 拦；
//   vite 会在打包时把这几份模块并进 bundle，运行时零 IO。
//
// 「有哪些卡」这件事搬去了 ./manifest.js —— 这个文件只负责把它们装进注册表。
// CARD_IDS 与内部 order 是**同一个数组实例**，注册新卡时 push 进去，所有
// `CARD_IDS.includes(id)` 的老调用点（core/lore.js 三处）自动跟上，不用改签名。
import { BUILT_IN_LORE, LORE_ID_RE, isValidCard, readUserCards } from './manifest.js';

export const DEFAULT_CARD_ID = 'ellen';

/** id → 卡对象。 */
const REGISTRY = new Map();

/** 展示顺序。CARD_IDS 就是它本身（live 引用），别换成拷贝。 */
const ORDER = [];

export const CARD_IDS = ORDER;

/** 兼容旧调用（`CARDS[id]` 那种写法）；对外只读语义，别拿来写。 */
export const CARDS = {};

function install(id, card, builtIn) {
  if (typeof id !== 'string' || !LORE_ID_RE.test(id)) return false;
  if (!isValidCard(card)) {
    console.warn('[lore] 角色卡内容不完整，跳过：', id);
    return false;
  }
  const existed = REGISTRY.has(id);
  REGISTRY.set(id, { ...card, id, builtIn: Boolean(builtIn) });
  CARDS[id] = REGISTRY.get(id);
  if (!existed) ORDER.push(id);
  return true;
}

/**
 * 运行时注册一张卡（导入流程用）。
 * 内置 id 不许覆盖：用户包不该悄悄替掉随包发行的角色。
 */
export function registerCard(id, card) {
  const builtIn = BUILT_IN_LORE.some((it) => it.id === id);
  if (builtIn) {
    console.warn('[lore] 内置角色卡不允许覆盖：', id);
    return false;
  }
  return install(id, card, false);
}

/** 卸载一张卡。内置卡卸不掉。 */
export function unregisterCard(id) {
  if (!REGISTRY.has(id) || REGISTRY.get(id).builtIn) return false;
  REGISTRY.delete(id);
  delete CARDS[id];
  const idx = ORDER.indexOf(id);
  if (idx >= 0) ORDER.splice(idx, 1);
  return true;
}

/** 当前所有卡的 id（快照，改它不影响注册表）。 */
export function cardIds() {
  return ORDER.slice();
}

/** 这张卡是不是随包发行的（决定设置页能不能删）。 */
export function isBuiltInCard(id) {
  return Boolean(REGISTRY.get(id)?.builtIn);
}

// ——— 安装：先内置、后用户 ———
BUILT_IN_LORE.forEach((it) => install(it.id, it.card, true));
readUserCards().forEach((it) => install(it.id, it.card, false));

/** 取卡；认不出来时回落到默认卡，绝不返回 undefined（调用方直接读 .core）。 */
export function cardOf(id) {
  return REGISTRY.get(id) || REGISTRY.get(DEFAULT_CARD_ID) || REGISTRY.get(ORDER[0]);
}
