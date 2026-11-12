// 设置 · 聊天模型（二级页）。原来这是设置首页第一张卡，三步向导占屏最高，单独一页才不挡路。
import { s } from '../../../strings.zh.js';
import { createModelCard } from './model-card.js';
import { createVisionCard } from './vision-card.js';
import './model-card.css';
import './settings.css';

export function createModelPage({ state, onChange } = {}) {
  return {
    mount(el) {
      el.classList.add('el-scroll-page', 'el-settings-context');

      const title = document.createElement('h1');
      title.className = 'el-page-title';
      title.textContent = s('settings.pageModel');
      const subtitle = document.createElement('p');
      subtitle.className = 'el-page-subtitle';
      subtitle.textContent = s('settings.pageModelHint');
      el.append(title, subtitle);

      el.append(createModelCard({ state, onChange }));

      // 视觉模型：可选功能，排在聊天模型后面（先配完能聊天的，再谈看图）。
      // 它自己读写 core/vision.js 的配置，不碰聊天配置。
      el.append(createVisionCard({ state, onChange }));

      // 横屏两栏：多列流只能挂在块容器上，标题留在外面通栏。
      const flow = document.createElement('div');
      flow.className = 'el-settings-flow';
      for (const node of [...el.children]) {
        if (node === title) continue;
        flow.append(node);
      }
      el.append(flow);

    },
  };
}
