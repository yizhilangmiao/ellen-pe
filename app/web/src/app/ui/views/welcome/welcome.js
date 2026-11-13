// 首次打开引导（4–6 步）。只做三件事：说清楚她是谁、把她需要的几个开关收下来、把旧资料搬进来。
//
// 分工：
//   * 步骤表与断点状态 ← core/onboarding.js（纯逻辑，可 node 直测）
//   * 搬旧数据 ← core/legacy.js（现成的 scanLegacy / importAllLegacy，这里不另写一套）
//   * 主动消息开关 ← core/autonomy-prefs.js + core/proactive.js（跟设置页写同一份存储）
//
// 本文件里所有句子都在下面这张 TXT 表里：strings.zh.js 由 Lead 统一收口，我不去改它。
import { pages } from '../../../strings.zh.js';
import portraitUrl from '../../../assets/ellen-portrait.webp';
import {
  buildSteps,
  markDone,
  markStep,
  progressOf,
  readOnboarded,
  resumeIndex,
  STEP_DONE,
  STEP_LEGACY,
  STEP_MEMORY,
  STEP_PING,
  STEP_TALK,
  STEP_WHO,
} from '../../../core/onboarding.js';
import { scanLegacy, importAllLegacy } from '../../../core/legacy.js';
import { readAutonomyPrefs, writeAutonomyPrefs } from '../../../core/autonomy-prefs.js';
import { setEnabled } from '../../../core/proactive.js';
import * as recorder from '../../../core/recorder.js';
import { push } from '../../router.js';
import { iconEl } from '../../icons.js';
import './welcome.css';

// 文案常量表：Lead 统一并进 strings.zh.js 时按这里的 key 搬。
const TXT = pages.welcome;

function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined && text !== null) el.textContent = String(text);
  return el;
}

function button(cls, text) {
  const el = h('button', cls, text);
  el.type = 'button';
  return el;
}

/** 旧包的导出文件名长这样：艾莲聊天资料-2026-11-12.ellenpack —— 只显示月日，省地方。 */
function dateLabel(at) {
  if (!at) return '';
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  return `${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`;
}

function sizeLabel(bytes) {
  const n = Number(bytes) || 0;
  if (!n) return '';
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

export function createWelcomeView({ state, onFinished, onOpenBackup } = {}) {
  return {
    mount(el) {
      el.classList.add('el-welcome-page');

      let steps = buildSteps({ legacyCount: 0 });
      let index = 0;
      let legacy = { items: [], oldInstalled: false, supported: false };
      let phase = 'loading'; // loading | ready | busy
      let dead = false;
      let pingPick = '';

      const bar = h('div', 'el-welcome-bar');
      const dots = h('div', 'el-welcome-dots');
      const skipBtn = button('el-welcome-skip', TXT.skip);
      bar.append(dots, skipBtn);

      const stage = h('div', 'el-welcome-stage');

      const foot = h('div', 'el-welcome-foot');
      const backBtn = button('el-welcome-back', TXT.back);
      const primary = button('el-welcome-primary', TXT.next);
      const feedback = h('p', 'el-welcome-feedback', '');
      const footRow = h('div', 'el-welcome-foot-row');
      footRow.append(backBtn, primary);
      foot.append(feedback, footRow);

      const loading = h('p', 'el-welcome-loading', TXT.loading);
      stage.append(loading);

      el.append(bar, stage, foot);

      // —— 状态落盘 ——
      function saveStep() {
        const step = steps[index];
        markStep(index, step ? step.id : '');
      }

      function finish(skipped) {
        const step = steps[index];
        markDone({ skipped, step: index, stepId: step ? step.id : '' });
        if (typeof onFinished === 'function') {
          try {
            onFinished({ skipped: Boolean(skipped) });
          } catch (err) {
            // 接线方出错不该把人卡在引导页：状态已经写了，下次就不会再进来
            console.error('[welcome] onFinished 失败', err);
          }
        }
      }

      function setFeedback(text) {
        feedback.textContent = text || '';
        feedback.hidden = !text;
      }

      // —— 步骤条 ——
      function paintDots() {
        dots.replaceChildren();
        const p = progressOf(steps, index);
        steps.forEach((step, i) => {
          const dot = button('el-welcome-dot', '');
          dot.setAttribute('aria-label', `${i + 1}/${p.count}`);
          if (i === index) dot.classList.add('is-active');
          else if (i < index) dot.classList.add('is-done');
          // 只允许往回点：往前跳会绕掉中间的开关，那不是「继续」该有的自由
          dot.disabled = i >= index || phase !== 'ready';
          dot.addEventListener('click', () => {
            if (i >= index) return;
            index = i;
            saveStep();
            render();
          });
          dots.append(dot);
        });
      }

      // —— 每一步的小动作 ——
      function stepTalk(body) {
        const row = h('div', 'el-welcome-actions');
        const mic = button('el-welcome-btn', TXT.steps[STEP_TALK].mic);
        mic.prepend(iconEl('mic'));
        const hint = h('p', 'el-welcome-hint', '');
        mic.addEventListener('click', async () => {
          mic.disabled = true;
          setFeedback(TXT.steps[STEP_TALK].micAsking);
          try {
            if (!(await recorder.available())) {
              hint.textContent = TXT.steps[STEP_TALK].micUnsupported;
              return;
            }
            // 原生没有「单独申请录音权限」的接口：系统弹窗只在第一次真开录时出现。
            // 所以这里开一个 0.6 秒再立刻取消 —— 目的只是把弹窗引出来，
            // cancel 会让原生删掉半截文件，不会留下录音，也不会上传。
            await recorder.start({ maxDurationMs: 600 });
            await recorder.cancel();
            hint.textContent = TXT.steps[STEP_TALK].micOk;
          } catch (err) {
            const code = (err && err.code) || '';
            hint.textContent = code === 'AUDIO_PERMISSION' ? TXT.steps[STEP_TALK].micDenied : TXT.steps[STEP_TALK].micFail;
          } finally {
            mic.disabled = false;
            setFeedback('');
          }
        });
        row.append(mic);
        body.append(row, hint);
      }

      function stepMemory(body) {
        const row = h('div', 'el-welcome-actions');
        const btn = button('el-welcome-btn', TXT.steps[STEP_MEMORY].backup);
        btn.prepend(iconEl('history'));
        btn.addEventListener('click', () => {
          // 优先交给外层接线（welcome 可能不在路由栈里，直接 push 会让返回键落回聊天页）。
          // 没接线时退回 push：至少能在栈里叠一层，回来仍在引导。
          if (typeof onOpenBackup === 'function') {
            try {
              onOpenBackup();
              return;
            } catch (err) {
              console.warn('[welcome] onOpenBackup 失败', err);
            }
          }
          try {
            push('settings-backup');
          } catch (err) {
            console.warn('[welcome] 打不开备份页', err);
          }
        });
        row.append(btn);
        body.append(row);
      }

      function stepLegacy(body) {
        const items = legacy.items || [];
        const list = h('div', 'el-welcome-list');
        items.slice(0, 4).forEach((it) => {
          const row = h('div', 'el-welcome-item');
          row.append(h('span', 'el-welcome-item-name', it.name));
          const meta = [dateLabel(it.at), sizeLabel(it.size)].filter(Boolean).join(' · ');
          if (meta) row.append(h('span', 'el-welcome-item-meta', meta));
          list.append(row);
        });
        if (items.length > 4) list.append(h('div', 'el-welcome-item-more', TXT.steps[STEP_LEGACY].more(items.length - 4)));
        body.append(list);

        const row = h('div', 'el-welcome-actions');
        const btn = button('el-welcome-btn', TXT.steps[STEP_LEGACY].import(items.length));
        const hint = h('p', 'el-welcome-hint', '');
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          // 搬到一半退出会留下半份数据，所以这段时间把「跳过/继续/上一步」一起按住
          phase = 'busy';
          setFeedback('');
          hint.textContent = '';
          try {
            const res = await importAllLegacy(items, ({ index: i, total }) => {
              hint.textContent = TXT.steps[STEP_LEGACY].importing(i + 1, total);
            });
            const lines = [TXT.steps[STEP_LEGACY].imported(res.imported, res.heads)];
            if (res.failed) lines.push(TXT.steps[STEP_LEGACY].partial(res.failed));
            hint.textContent = lines.join(' ');
            // 搬完这一步就没内容了：直接把主按钮改成「继续」，不让人再点一次
            if (index === steps.length - 1) primary.textContent = TXT.start;
          } catch (err) {
            hint.textContent = (err && (err.message || err.code)) || String(err);
            btn.disabled = false;
          } finally {
            phase = 'ready';
            // 重新刷一遍按钮可用态（搬完了也不该再点第二遍）
            primary.disabled = false;
            backBtn.disabled = false;
            skipBtn.disabled = false;
          }
        });
        row.append(btn);
        body.append(row, hint);
      }

      function stepPing(body) {
        const prefs = readAutonomyPrefs();
        const options = TXT.steps[STEP_PING].options;
        if (!pingPick) {
          // 默认跟着现有偏好走：关着就是「先不用」，开着就选最接近的那个间隔
          if (prefs.enabled === false) pingPick = 'off';
          else {
            const near = options
              .filter((o) => o.id !== 'off')
              .reduce((a, b) => (Math.abs(b.intervalH - prefs.intervalH) < Math.abs(a.intervalH - prefs.intervalH) ? b : a));
            pingPick = near.id;
          }
        }
        const chips = h('div', 'el-welcome-chips');
        options.forEach((opt) => {
          const chip = button('el-welcome-chip', opt.label);
          if (opt.id === pingPick) chip.classList.add('is-active');
          chip.addEventListener('click', () => {
            pingPick = opt.id;
            for (const node of chips.children) node.classList.toggle('is-active', node === chip);
            applyPing(opt);
          });
          chips.append(chip);
        });
        body.append(chips);
      }

      async function applyPing(opt) {
        const on = opt.id !== 'off';
        const cur = readAutonomyPrefs();
        // 与设置页写同一份存储：这里选的间隔，设置页里看到的就是这个
        writeAutonomyPrefs({ enabled: on, intervalH: opt.intervalH || cur.intervalH });
        try {
          const profileId = (state && state.profileId) || '';
          await setEnabled(on, { profileId });
        } catch (err) {
          // 没装原生插件（网页预览/模拟器）时排不了程；偏好已经写了，真机上打开设置页再开一次也行
          console.warn('[welcome] 主动消息开关没生效', err);
        }
      }

      // —— 渲染当前这一步 ——
      function render() {
        if (dead) return;
        stage.replaceChildren();
        paintDots();
        const step = steps[index] || steps[steps.length - 1];
        const copy = TXT.steps[step.id] || TXT.steps[STEP_DONE];

        const casing = h('div', 'el-welcome-card');
        if (copy.eyebrow) casing.append(h('p', 'el-welcome-eyebrow', copy.eyebrow));
        casing.append(h('h1', 'el-welcome-title', copy.title));
        const text = typeof copy.text === 'function' ? copy.text((legacy.items || []).length) : copy.text;
        casing.append(h('p', 'el-welcome-text', text));
        if (copy.note) casing.append(h('p', 'el-welcome-note', copy.note));

        const body = h('div', 'el-welcome-body');
        if (step.id === STEP_WHO) {
          const fig = h('div', 'el-welcome-portrait');
          const img = document.createElement('img');
          img.src = portraitUrl;
          img.alt = '';
          img.decoding = 'async';
          fig.append(img);
          casing.append(fig);
        } else if (step.id === STEP_TALK) stepTalk(body);
        else if (step.id === STEP_MEMORY) stepMemory(body);
        else if (step.id === STEP_LEGACY) stepLegacy(body);
        else if (step.id === STEP_PING) stepPing(body);
        casing.append(body);
        stage.append(casing);

        const p = progressOf(steps, index);
        primary.textContent = p.index === p.count - 1 ? TXT.start : TXT.next;
        primary.disabled = phase !== 'ready';
        backBtn.hidden = p.index === 0;
        backBtn.disabled = phase !== 'ready';
        skipBtn.disabled = phase !== 'ready';
      }

      primary.addEventListener('click', () => {
        if (phase !== 'ready') return;
        if (index >= steps.length - 1) {
          finish(false);
          return;
        }
        index += 1;
        saveStep();
        render();
      });

      backBtn.addEventListener('click', () => {
        if (phase !== 'ready') return;
        if (index <= 0) return;
        index -= 1;
        saveStep();
        render();
      });

      skipBtn.addEventListener('click', () => {
        if (phase === 'busy') return;
        finish(true);
      });

      // —— 起手：先看有没有旧数据，再决定步骤表 ——
      (async () => {
        try {
          legacy = await scanLegacy();
        } catch (err) {
          console.warn('[welcome] 扫旧资料失败', err);
          legacy = { items: [], supported: false };
        }
        if (dead) return;
        steps = buildSteps({ legacyCount: (legacy.items || []).length });
        index = resumeIndex(steps, readOnboarded());
        phase = 'ready';
        render();
        // 断点续：进来就先把「我停在这一步」写一遍，
        // 这样「上次看的是第 5 步、这次旧数据没了」的情况也能立刻收敛到新表上
        saveStep();
      })();

      return {
        destroy() {
          dead = true;
        },
      };
    },
  };
}
