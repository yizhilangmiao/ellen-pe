// 设置 · 语音通话（二级页）。
//
// 只放三个真会影响通话手感的东西：免提、连续通话、以及「语速在哪改」的指路。
// 为什么语速不在这里放滑杆：声音页已经有一份语速，两处都能改就会互相覆盖，
// 而且用户改完语速回到通话页不知道以哪个为准。这里只显示当前值 + 一个跳转。
import { push } from '../../router.js';
import { readCallPrefs, writeCallPrefs, resetCallPrefs } from '../../../core/call.js';
import { readPrefs as readVoicePrefs } from '../../../core/speech.js';
import './settings.css';

// 文案先放本地常量：strings.zh.js 这一轮不归我写。搬过去时按 `settings.call*` 命名。
const T = {
  title: '语音通话',
  subtitle: '她直接说话，你直接开口。这里只留会改变通话手感的三项。',
  cardTitle: '通话偏好',
  handsFreeTitle: '默认免提',
  handsFreeDesc: '进通话页就用扬声器。关掉是听筒模式（本机走系统播报，仅作偏好记录）。',
  continuousTitle: '连续通话',
  continuousDesc: '她说完自动继续听。关掉的话，她说完这一句就挂断 —— 一次一问一答。',
  rateTitle: '说话语速',
  rateDesc: '语速和音色与「声音」页共用一份设置，改那里即可。',
  rateUnit: '倍速',
  rateLink: '去声音页改',
  reset: '恢复默认',
  resetDone: '已恢复默认。',
  on: '开',
  off: '关',
};

export function createCallSettingsPage({ state, onChange } = {}) {
  return {
    mount(el) {
      el.classList.add('el-scroll-page', 'el-settings-context');

      const title = document.createElement('h1');
      title.className = 'el-page-title';
      title.textContent = T.title;
      const subtitle = document.createElement('p');
      subtitle.className = 'el-page-subtitle';
      subtitle.textContent = T.subtitle;
      el.append(title, subtitle);

      const card = document.createElement('div');
      card.className = 'el-settings-card';

      const head = document.createElement('div');
      head.className = 'el-settings-card-head';
      const cardTitle = document.createElement('div');
      cardTitle.className = 'el-settings-card-title';
      cardTitle.textContent = T.cardTitle;
      head.append(cardTitle);

      // 开关行：整套设置页共用的写法（.el-settings-toggle-row + .el-settings-switch）
      function toggleRow(titleText, descText) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'el-settings-toggle-row';
        const copy = document.createElement('div');
        copy.className = 'el-settings-toggle-copy';
        const name = document.createElement('div');
        name.className = 'el-settings-toggle-title';
        name.textContent = titleText;
        const desc = document.createElement('div');
        desc.className = 'el-settings-toggle-desc';
        desc.textContent = descText;
        copy.append(name, desc);
        const sw = document.createElement('span');
        sw.className = 'el-settings-switch';
        row.append(copy, sw);
        return { row, sw };
      }

      const handsFree = toggleRow(T.handsFreeTitle, T.handsFreeDesc);
      const continuous = toggleRow(T.continuousTitle, T.continuousDesc);

      const toggles = document.createElement('div');
      toggles.className = 'el-settings-toggles';
      toggles.append(handsFree.row, continuous.row);

      // 语速：只读一行 + 跳转，避免和声音页两份设置打架
      const rateRow = document.createElement('div');
      rateRow.className = 'el-settings-row';
      const rateCopy = document.createElement('div');
      rateCopy.className = 'el-settings-toggle-copy';
      const rateName = document.createElement('div');
      rateName.className = 'el-settings-toggle-title';
      rateName.textContent = T.rateTitle;
      const rateDesc = document.createElement('div');
      rateDesc.className = 'el-settings-toggle-desc';
      rateDesc.textContent = T.rateDesc;
      rateCopy.append(rateName, rateDesc);
      const rateValue = document.createElement('span');
      rateValue.className = 'el-settings-status';
      const rateBtn = document.createElement('button');
      rateBtn.type = 'button';
      rateBtn.className = 'el-settings-btn is-ghost';
      rateBtn.textContent = T.rateLink;
      rateBtn.addEventListener('click', () => push('settings-voice'));
      rateRow.append(rateCopy, rateValue, rateBtn);

      const note = document.createElement('div');
      note.className = 'el-settings-note';

      const resetRow = document.createElement('div');
      resetRow.className = 'el-settings-row';
      const resetBtn = document.createElement('button');
      resetBtn.type = 'button';
      resetBtn.className = 'el-settings-btn is-ghost';
      resetBtn.textContent = T.reset;
      resetRow.append(resetBtn);

      card.append(head, toggles, rateRow, note, resetRow);
      el.append(card);

      function paint() {
        const prefs = readCallPrefs();
        handsFree.row.classList.toggle('is-on', !!prefs.handsFree);
        handsFree.sw.classList.toggle('is-on', !!prefs.handsFree);
        continuous.row.classList.toggle('is-on', !!prefs.continuous);
        continuous.sw.classList.toggle('is-on', !!prefs.continuous);
        let rate = 1;
        try {
          const vp = readVoicePrefs();
          if (vp && typeof vp.rate === 'number' && vp.rate > 0) rate = vp.rate;
        } catch (_) {
          /* 读不到就按 1 倍显示，别让整页崩掉 */
        }
        rateValue.textContent = `${rate.toFixed(2)}${T.rateUnit}`;
      }

      handsFree.row.addEventListener('click', () => {
        const next = !readCallPrefs().handsFree;
        writeCallPrefs({ handsFree: next });
        paint();
        if (typeof onChange === 'function') onChange();
      });

      continuous.row.addEventListener('click', () => {
        const next = !readCallPrefs().continuous;
        writeCallPrefs({ continuous: next });
        paint();
        if (typeof onChange === 'function') onChange();
      });

      resetBtn.addEventListener('click', () => {
        resetCallPrefs();
        paint();
        note.textContent = T.resetDone;
        if (typeof onChange === 'function') onChange();
      });

      paint();

      return {
        // 从声音页 pop 回来时语速可能变了，重新读一遍
        resume() {
          paint();
        },
      };
    },
  };
}
