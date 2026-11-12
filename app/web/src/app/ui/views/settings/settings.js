// 设置首页：只放「分组 + 入口行」。
//
// 为什么不继续一页铺到底：模型向导 + 声音三步 + 备份 + 更新挤在一起，360 宽要划四五次才到底，
// 想改一个开关得先找。现在重内容各自成页（settings-* 由 main.js 注册），首页一行一个入口，
// 右边带摘要 —— 不点进去也能看出「配没配」。返回键/顶栏返回由 router 的栈自动处理。
import { s } from '../../../strings.zh.js';
import { platformOf, isUsable } from '../../../core/config.js';
import { readPrefs as readVoicePrefs } from '../../../core/speech.js';
import { state as backupState } from '../../../core/backup.js';
import { push } from '../../router.js';
// 角色卡摘要：卡名是数据不是文案，直接读当前选中的卡
import { describeCard, readLoreSelection } from '../../../core/lore.js';
import './settings.css';

export function createSettingsView({ state } = {}) {
  return {
    mount(el) {
      el.classList.add('el-scroll-page', 'el-settings-context');

      const title = document.createElement('h1');
      title.className = 'el-page-title';
      title.textContent = s('settings.title');

      const subtitle = document.createElement('p');
      subtitle.className = 'el-page-subtitle';
      subtitle.textContent = s('settings.subtitle');

      el.append(title, subtitle);

      function group(textKey) {
        const node = document.createElement('div');
        node.className = 'el-settings-group-title';
        node.textContent = s(textKey);
        return node;
      }

      // 一行入口：左边标题 + 摘要，右边箭头。整行可点。
      function entry({ view, titleKey, summary, hintKey }) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'el-settings-entry';
        row.dataset.view = view;
        row.setAttribute('aria-label', `${s(titleKey)}${summary ? `，${summary}` : ''}`);

        const main = document.createElement('span');
        main.className = 'el-settings-entry-main';
        const name = document.createElement('span');
        name.className = 'el-settings-entry-title';
        name.textContent = s(titleKey);
        const sum = document.createElement('span');
        sum.className = 'el-settings-entry-sum';
        sum.textContent = summary || '';
        main.append(name, sum);

        const hint = document.createElement('span');
        hint.className = 'el-settings-entry-hint';
        hint.textContent = hintKey ? s(hintKey) : '';
        hint.hidden = !hintKey;

        const arrow = document.createElement('span');
        arrow.className = 'el-settings-entry-arrow';
        arrow.setAttribute('aria-hidden', 'true');
        arrow.textContent = '›';

        row.append(main, arrow);
        row.addEventListener('click', () => push(view));
        return { row, sum };
      }

      // —— 摘要：不点进去也要能看出「配没配」——
      let cfg = null;
      try {
        cfg = (state && state.getConfig && state.getConfig()) || null;
      } catch (_) {
        cfg = null;
      }
      const modelSummary = (() => {
        if (!cfg || !isUsable(cfg)) return s('settings.notSet');
        const p = platformOf(cfg.platform);
        return `${(p && p.label) || cfg.platform} · ${cfg.model || '—'}`;
      })();

      const voiceSummary = (() => {
        try {
          const prefs = readVoicePrefs();
          const cloned = prefs.voiceId && prefs.voiceId !== 'female-shaonv';
          const tone = cloned ? s('settings.voiceCloudCloned') : s('settings.voiceCloudBuiltin');
          return `${tone} · ${s('settings.voiceReadShort')}${prefs.auto ? s('settings.on') : s('settings.off')}`;
        } catch (_) {
          return s('settings.notSet');
        }
      })();

      // —— 聊天与声音 ——
      el.append(group('settings.groupChatAndVoice'));
      const modelEntry = entry({ view: 'settings-model', titleKey: 'settings.entryModel', summary: modelSummary });
      const voiceEntry = entry({ view: 'settings-voice', titleKey: 'settings.entryVoice', summary: voiceSummary });
      el.append(modelEntry.row, voiceEntry.row);

      // —— 数据 ——
      el.append(group('settings.groupData'));
      const backupEntry = entry({ view: 'settings-backup', titleKey: 'settings.entryBackup', summary: s('settings.entryBackupUnknown') });
      el.append(backupEntry.row);
      // 备份状态要读原生（异步），拿到再回填，别让首页等着
      backupState()
        .then((st) => {
          const on = !!(st && st.enabled);
          const days = Number(st && st.intervalDays) || 7;
          backupEntry.sum.textContent = on
            ? `${s('settings.backupOn')} · ${days} ${s('settings.backupDaysUnit')}`
            : s('settings.backupOff');
        })
        .catch(() => {
          backupEntry.sum.textContent = s('settings.backupOff');
        });

      // —— 陪伴 ——
      el.append(group('settings.groupCharacter'));
      const compEntry = entry({ view: 'settings-companion', titleKey: 'settings.entryCompanion', summary: s('settings.entryCompanionSum') });
      // 角色卡：摘要写卡名，读失败就留空（不阻断首页）
      const loreSummary = (() => {
        try {
          const card = describeCard((readLoreSelection() || {}).cardId);
          return card && card.label ? card.label : '';
        } catch (_) {
          return '';
        }
      })();
      const loreEntry = entry({ view: 'settings-lore', titleKey: 'settings.entryLore', summary: loreSummary || s('settings.entryLoreSum') });
      // 心情：只读调试页，摘要不预读状态（读盘留给页面自己，别堵首页）
      const affectEntry = entry({ view: 'settings-affect', titleKey: 'settings.entryAffect', summary: s('settings.entryAffectSum') });
      // 语音通话：连续对话 / 免提 / 语速回显（语速本体仍在 voice 页）
      const callEntry = entry({ view: 'settings-call', titleKey: 'settings.entryCall', summary: s('settings.entryCallDesc') });
      el.append(compEntry.row, loreEntry.row, affectEntry.row, callEntry.row);

      // —— 其他 ——
      el.append(group('settings.groupOther'));
      const aboutEntry = entry({ view: 'settings-about', titleKey: 'settings.entryAbout', summary: s('settings.entryAboutSum') });
      el.append(aboutEntry.row);

      // 横屏两栏：多列流只能挂在块容器上，标题留在外面通栏。
      const flow = document.createElement('div');
      flow.className = 'el-settings-flow';
      for (const node of [...el.children]) {
        if (node === title || node === subtitle) continue;
        flow.append(node);
      }
      el.append(flow);

      return {};
    },
  };
}
