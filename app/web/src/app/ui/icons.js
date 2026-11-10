/**
 * 线框图标（照抄旧包 SVG，viewBox 24×24 / stroke=currentColor / stroke-width 1.6）。
 * 旧包实测尺寸：底栏图标 21×21、顶栏 20×20，容器 `.el-icon` 24×24 居中。
 * 每个图标都是同一套 svg 属性，只有内部 path 不同 —— 用 ICON_ATTRS 统一拼。
 */
const ICON_ATTRS =
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
  'stroke-linecap="round" stroke-linejoin="round"';

/** 图标体（不含 <svg> 外壳）。 */
export const PATHS = {
  // 底栏
  chat: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5A8.5 8.5 0 0 1 10.5 3h2a8.5 8.5 0 0 1 8.5 8.5Z"></path><path d="M7 10h10M7 14h6"></path>',
  memory:
    '<path d="M12 6c-3-3-7-3-10-2v15c3-1 7-1 10 2 3-3 7-3 10-2V4c-3-1-7-1-10 2Zm0 0v15"></path>',
  companion: '<path d="m12 21-8-8A5.5 5.5 0 0 1 12 5a5.5 5.5 0 0 1 8 8Z"></path>',
  settings:
    '<path d="m9 3-1 3-3 1 1 3-1 3 3 1 1 3h4l1-3 3-1-1-3 1-3-3-1-1-3Z" transform="translate(1 2)"></path><circle cx="12" cy="12" r="3"></circle>',
  // 顶栏
  background:
    '<rect x="3" y="3" width="18" height="18" rx="3"></rect><circle cx="8" cy="8" r="1.5"></circle><path d="m3 17 5-5 4 4 4-6 5 6"></path>',
  appearance:
    '<path d="M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1-4c-1-1 0-3 2-3h2a3 3 0 0 0 3-3 9 9 0 0 0-9-8Z"></path><circle cx="7.5" cy="10" r=".8"></circle><circle cx="10" cy="6.5" r=".8"></circle><circle cx="14.5" cy="6.5" r=".8"></circle><circle cx="17" cy="10" r=".8"></circle>',
  history: '<path d="M3 12a9 9 0 1 0 3-7M3 3v5h5M12 7v5l3 2"></path>',
  notices:
    '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"></path>',
  // 通用
  back: '<path d="m15 18-6-6 6-6"></path>',
  close: '<path d="m6 6 12 12M18 6 6 18"></path>',
  send: '<path d="M12 19V5M5 12l7-7 7 7"></path>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1.5"></rect>',
  plus: '<path d="M12 5v14M5 12h14"></path>',
  search: '<circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path>',
  // 记忆卡片右上角那本翻开的书（照旧包卡片图标）
  book: '<path d="M12 6c-3-3-7-3-10-2v15c3-1 7-1 10 2 3-3 7-3 10-2V4c-3-1-7-1-10 2Zm0 0v15"></path>',
  check: '<path d="m4 12 5 5L20 6"></path>',
  mic: '<rect x="9" y="2" width="6" height="11" rx="3"></rect><path d="M5 11a7 7 0 0 0 14 0M12 18v4M8 22h8"></path>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="m3 7 9 6 9-6"></path>',
  volume: '<path d="M11 5 6 9H3v6h3l5 4Z"></path><path d="M16 9a4 4 0 0 1 0 6"></path><path d="M19 6a8 8 0 0 1 0 12"></path>',
  muted: '<path d="M11 5 6 9H3v6h3l5 4Z"></path><path d="m16 9 6 6M22 9l-6 6"></path>',
};

/** 拼一个完整的 <svg> 字符串。 */
export function svg(name) {
  const body = PATHS[name];
  if (!body) return '';
  return `<svg ${ICON_ATTRS} aria-hidden="true">${body}</svg>`;
}

/** 建一个带图标的 span（旧包同款结构 `<span class="el-icon">`）。 */
export function iconEl(name, cls = 'el-icon') {
  const span = document.createElement('span');
  span.className = cls;
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = svg(name);
  return span;
}

/** 把一个已有元素填成图标（元素原来的文本会被清掉）。 */
export function setIcon(el, name) {
  el.textContent = '';
  el.append(iconEl(name));
  return el;
}
