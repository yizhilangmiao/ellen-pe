// 未开工页面的占位视图：先把导航跑通，页面内容按里程碑逐个替换成真视图。
// 每个占位都显示页面标题 + 副标题 + 一行"待办"，避免空白页让人以为崩了。
import { s } from '../../strings.zh.js';

export function createPlaceholderView({ titleKey, subtitleKey, rows = [] }) {
  return {
    mount(el) {
      el.classList.add('el-scroll-page');
      const title = document.createElement('h1');
      title.className = 'el-page-title';
      title.textContent = s(titleKey);
      el.append(title);

      if (subtitleKey) {
        const sub = document.createElement('p');
        sub.className = 'el-page-subtitle';
        sub.textContent = s(subtitleKey);
        el.append(sub);
      }

      for (const row of rows) {
        const card = document.createElement('div');
        card.className = 'el-placeholder-row';
        card.textContent = row;
        el.append(card);
      }
      return { destroy() {} };
    },
  };
}
