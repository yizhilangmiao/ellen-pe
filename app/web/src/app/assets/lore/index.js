// 角色卡注册表。
//
// 为什么在 assets/ 里而不是 core/：这里是数据（会随素材更新变），core/ 只放逻辑。
// 为什么用静态 import 而不是运行时 fetch：App 走 file:///android_asset/，fetch 会被 WebView 拦；
//   vite 会在打包时把这几份模块并进 bundle，运行时零 IO。
import ellen from './ellen.js';
import ellenLover from './ellen-lover.js';

// 顺序即设置页里的展示顺序：原作向在前，恋人卡在后（老大的默认是原作向）。
export const CARD_IDS = ['ellen', 'ellen-lover'];

export const DEFAULT_CARD_ID = 'ellen';

export const CARDS = {
  ellen,
  'ellen-lover': ellenLover,
};

/** 取卡；认不出来时回落到默认卡，绝不返回 undefined（调用方直接读 .core）。 */
export function cardOf(id) {
  return CARDS[id] || CARDS[DEFAULT_CARD_ID];
}
