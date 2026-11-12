// 设置 · 情绪状态（二级页，只读调试页）：把 mood-v1 里的七维、档位、注入块摊开给老大看。
//
// 为什么只读：情绪是被「聊天事件 + 时间」推动的，从设置页手改数值会绕开事件表、余怨、
// 第一次记录，改完状态和聊天记录立刻对不上；要调就动常量重跑自测，不要在这一页拧旋钮。
// 所以这里既不提供输入框，也不调用 saveAffect —— 读的时候连落盘都关掉（persist:false），
// 免得「来看一眼」就把一份快照写进库。
import './settings.css';
import {
  DIMS,
  DAILY,
  HALF_LIFE_H,
  loadAffect,
  snapshot,
  softCaps,
  willingness,
  effectiveDesire,
  bandOf,
  coldness,
  derivedMood,
} from '../../../core/affect.js';
import { renderInjection, countHan, activeGrudges, recentFirsts, neglectInfo } from '../../../core/affect-events.js';

// 中文名按文档第二章的叫法，不另起名字：同一个东西在代码、文档、页面上必须同名
const DIM_LABEL = {
  lust: '性欲',
  lewd: '尺度',
  possess: '占有',
  shame: '羞耻',
  resist: '理智',
  fatigue: '疲劳',
  affection: '好感',
};

const GRUDGE_LABEL = { leave: '说要走', lie: '撒谎', force: '硬来', scold: '凶一句' };
// 键名跟 affect-events.js 里 EVENTS[*].first 对齐（touch / asked / leave），别自己造
const FIRST_LABEL = { touch: '第一次被碰', asked: '第一次被要', leave: '第一次听说要走' };

/** 一个小标题 + 一个说明 + 一个内容容器。settings.css 里没有通用 pre 类，正文一律走 note。 */
function makeCard(titleText, hintText) {
  const card = document.createElement('div');
  card.className = 'el-settings-card';
  const head = document.createElement('div');
  head.className = 'el-settings-card-head';
  const title = document.createElement('div');
  title.className = 'el-settings-card-title';
  title.textContent = titleText;
  head.append(title);
  card.append(head);
  if (hintText) {
    const hint = document.createElement('div');
    hint.className = 'el-settings-card-hint';
    hint.textContent = hintText;
    card.append(hint);
  }
  return card;
}

/** 一行「左边名字、右边数值」。数值只在这一层做两位小数，内存里始终是浮点。 */
function makeReadout(labelText) {
  const field = document.createElement('div');
  field.className = 'el-settings-field';
  const label = document.createElement('span');
  label.className = 'el-settings-label';
  label.textContent = labelText;
  const value = document.createElement('div');
  value.className = 'el-settings-note';
  field.append(label, value);
  return { field, value };
}

// store 只在自测里用（内存 Map）；真实运行时是 undefined，loadAffect 会退回 records.js。
// 留这个口子是为了能在没有 indexedDB 的环境里把 mount() 真跑一遍。
export function createAffectPage({ state, onChange, store } = {}) {
  return {
    mount(el) {
      el.classList.add('el-scroll-page', 'el-settings-context');

      const title = document.createElement('h1');
      title.className = 'el-page-title';
      title.textContent = '情绪状态';
      const subtitle = document.createElement('p');
      subtitle.className = 'el-page-subtitle';
      // 先说清「为什么不能改」，不然下一轮又有人来问这里为什么不能编辑
      subtitle.textContent = '只读。数值由聊天事件与时间推出来，手改会与聊天记录对不上。';
      el.append(title, subtitle);

      // —— 七维 ——
      const dimsCard = makeCard('七维（两位小数）', '括号里是日常值；时间只往日常值回落，永不穿过它。');
      const dimRows = {};
      for (const dim of DIMS) {
        const row = makeReadout(`${DIM_LABEL[dim]} ${dim}`);
        dimRows[dim] = row.value;
        dimsCard.append(row.field);
      }
      const softLine = document.createElement('div');
      softLine.className = 'el-settings-note';
      dimsCard.append(softLine);
      const derived = makeReadout('派生情绪（给 companion.js 的 {mood, note}）');
      const cold = makeReadout('三种冷');
      const effRow = makeReadout('eff 有效欲望 / 意愿 / 档位');
      dimsCard.append(effRow.field, derived.field, cold.field);
      el.append(dimsCard);

      // —— 注入块原文 ——
      const injCard = makeCard(
        '当前注入块（原文）',
        '这段将来拼在 buildSystemPrompt() 后面。只读，需要就拿去贴。',
      );
      const inj = document.createElement('textarea');
      inj.className = 'el-settings-input el-settings-textarea';
      inj.readOnly = true;
      inj.rows = 5;
      inj.spellcheck = false;
      const injNote = document.createElement('div');
      injNote.className = 'el-settings-note';
      const injRow = document.createElement('div');
      injRow.className = 'el-settings-row';
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'el-settings-btn';
      copyBtn.textContent = '复制';
      const refreshBtn = document.createElement('button');
      refreshBtn.type = 'button';
      refreshBtn.className = 'el-settings-btn is-ghost';
      refreshBtn.textContent = '刷新';
      injRow.append(copyBtn, refreshBtn);
      injCard.append(inj, injNote, injRow);
      el.append(injCard);

      // —— 附注：余怨 / 第一次 / 被晾着 / 暂停 ——
      const extraCard = makeCard('附注', '这些不是七维，但会改写注入块的说法。');
      const grudgeRow = makeReadout('余怨');
      const firstRow = makeReadout('第一次（24h 内才带语气）');
      const neglectRow = makeReadout('被晾着');
      const pauseRow = makeReadout('暂停（安全词）');
      extraCard.append(grudgeRow.field, firstRow.field, neglectRow.field, pauseRow.field);
      el.append(extraCard);

      let current = null;

      function paint() {
        const st = current;
        if (!st) return;
        const snap = snapshot(st);
        const now = Date.now();
        for (const dim of DIMS) {
          const v = st.dims[dim];
          // lust 不在 HALF_LIFE_H 里（它是线性漂移），不判一下会显示成 undefined
          const decay = HALF_LIFE_H[dim] ? `半衰期 ${HALF_LIFE_H[dim]}h` : '线性漂移 −3 / +0.5 每小时';
          // 显示两位，但只在显示这一层取整（内存里留着浮点残差，见 affect.js 的注释）
          dimRows[dim].textContent = `${Number(v).toFixed(2)}（日常 ${DAILY[dim]}，${decay}）`;
        }
        const caps = softCaps(st.dims);
        // softCaps 返回的是「谁压谁 + 封顶值」的数组，不是对象，所以按数组直接拼
        softLine.textContent = caps
          .map((c) => `${DIM_LABEL[c.of]}→${DIM_LABEL[c.dim]} ${Number(c.cap).toFixed(2)}`)
          .join('，');

        const eff = effectiveDesire(st.dims);
        const band = bandOf(eff);
        effRow.value.textContent =
          `${eff.toFixed(2)} / 意愿 ${willingness(st.dims).toFixed(2)} / ${band.label}（≥${band.min}）`;

        const mood = derivedMood(st);
        derived.value.textContent = `${mood.mood} —— ${mood.note}`;

        const c = coldness(st.dims);
        cold.value.textContent =
          `身体冷 ${c.body ? '是' : '否'} · 话冷 ${c.words ? '是' : '否'} · 心冷 ${c.heart ? '是' : '否'}` +
          (c.body && c.words && c.heart ? '（三样同时冷 = 公事公办）' : '');

        const text = renderInjection(st, { now });
        if (inj.value !== text) inj.value = text;
        injNote.textContent = `${countHan(text)} / 220 汉字（含写法约束）`;

        const gs = activeGrudges(st, now);
        grudgeRow.value.textContent = gs.length
          ? gs.map((g) => `${GRUDGE_LABEL[g.kind] || g.kind} 到 ${new Date(Number(g.until)).toLocaleString()}`).join('；')
          : '无';
        const fs = recentFirsts(st, now);
        firstRow.value.textContent = fs.length ? fs.map((f) => FIRST_LABEL[f.key] || f.key).join('、') : '无';
        const ng = neglectInfo(st, now);
        neglectRow.value.textContent =
          `清醒 ${ng.awakeHours.toFixed(2)}h（阈 6h）· ${ng.neglected ? '算冷落' : '不算'} · ${ng.already ? '这次已记过' : '还没记'}`;
        pauseRow.value.textContent =
          st.pausedUntil && st.pausedUntil > now
            ? `到 ${new Date(Number(st.pausedUntil)).toLocaleTimeString()}`
            : '无';
      }

      async function refresh() {
        refreshBtn.disabled = true;
        try {
          // persist:false —— 看一眼不该产生副作用
          current = await loadAffect({ store, now: Date.now(), persist: false });
          paint();
          injNote.dataset.ok = '1';
        } catch (err) {
          injNote.textContent = `读不到状态：${String((err && err.message) || err)}`;
          injNote.classList.add('is-error');
        } finally {
          refreshBtn.disabled = false;
        }
      }

      copyBtn.addEventListener('click', async () => {
        const text = inj.value;
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
          } else {
            // WebView 里 clipboard 常常没授权，退回「全选 + execCommand」，让用户长按自己复制
            inj.focus();
            inj.select();
            document.execCommand('copy');
          }
          injNote.textContent = `${countHan(text)} / 220 汉字 · 已复制`;
        } catch (_) {
          inj.focus();
          inj.select();
          injNote.textContent = `${countHan(text)} / 220 汉字 · 已选中，长按复制`;
        }
      });
      refreshBtn.addEventListener('click', () => {
        refresh();
      });

      refresh();

      return {
        destroy() {
          current = null;
        },
      };
    },
  };
}
