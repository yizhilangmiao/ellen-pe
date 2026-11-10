// 手记详情（全屏页）。
//
// 旧包的手记是「日历 + 当天全屏」两段式（`_verify/ui-baseline/04-memory.png` 那页就是日历）；
// 新壳先做详情页，日历网格随后补。卡片点进来时把整份列表一起带进来，
// 这样「上一篇 / 下一篇」不用回库再查一遍。
import { s } from '../../../strings.zh.js';
import './journal.css';

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function dayParts(value, at) {
  const raw = value && value.day ? value.day : '';
  const base = raw ? new Date(`${raw}T00:00:00`) : new Date(at || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  const y = base.getFullYear();
  const m = pad(base.getMonth() + 1);
  const d = pad(base.getDate());
  return {
    day: `${y}-${m}-${d}`,
    week: WEEK[base.getDay()] || '',
    stamp: `${y} 年 ${Number(m)} 月 ${Number(d)} 日`,
  };
}

/** 把正文按空行拆段；每段再按单换行保留行内换行（pre-wrap 由 CSS 负责）。 */
function paragraphs(text) {
  return String(text || '')
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function createJournalView() {
  return {
    mount(el, params = {}) {
      el.classList.add('el-scroll-page', 'el-journal-page');

      const items = Array.isArray(params.items) ? params.items : [];
      let index = Number.isInteger(params.index) ? params.index : 0;

      const eyebrow = document.createElement('div');
      eyebrow.className = 'el-eyebrow';
      eyebrow.textContent = s('journal.eyebrow');

      const stamp = document.createElement('div');
      stamp.className = 'el-journal-stamp';

      const title = document.createElement('h1');
      title.className = 'el-journal-detail-title';

      const body = document.createElement('div');
      body.className = 'el-journal-body-text';

      const aside = document.createElement('div');
      aside.className = 'el-journal-aside';

      const pager = document.createElement('div');
      pager.className = 'el-journal-pager';
      const prev = document.createElement('button');
      prev.type = 'button';
      prev.className = 'el-journal-pager-btn';
      prev.dataset.dir = 'prev';
      prev.textContent = s('journal.prev');
      const next = document.createElement('button');
      next.type = 'button';
      next.className = 'el-journal-pager-btn';
      next.dataset.dir = 'next';
      next.textContent = s('journal.next');
      pager.append(prev, next);

      el.append(eyebrow, stamp, title, body, aside, pager);

      function paint() {
        const item = items[index];
        if (!item) {
          title.textContent = s('journal.empty');
          body.textContent = '';
          aside.hidden = true;
          prev.disabled = true;
          next.disabled = true;
          return;
        }
        const v = item.value || {};
        const parts = dayParts(v, item.at);
        stamp.textContent = `${parts.stamp} · ${parts.week}`;
        title.textContent = v.title || s('journal.untitled');

        body.replaceChildren();
        const chunks = paragraphs(v.diary);
        if (!chunks.length) {
          const p = document.createElement('p');
          p.className = 'el-journal-body-empty';
          p.textContent = s('journal.noBody');
          body.append(p);
        } else {
          for (const chunk of chunks) {
            const p = document.createElement('p');
            p.textContent = chunk;
            body.append(p);
          }
        }

        aside.replaceChildren();
        const thoughts = String(v.thoughts || '').trim();
        aside.hidden = !thoughts;
        if (thoughts) {
          const label = document.createElement('div');
          label.className = 'el-journal-aside-label';
          label.textContent = s('journal.aside');
          const text = document.createElement('p');
          text.className = 'el-journal-aside-text';
          text.textContent = thoughts;
          aside.append(label, text);
        }

        prev.disabled = index >= items.length - 1;
        next.disabled = index <= 0;
        // 换一篇后回到顶部，别停在上一篇的位置
        el.scrollTop = 0;
      }

      prev.addEventListener('click', () => {
        if (index >= items.length - 1) return;
        index += 1;
        paint();
      });
      next.addEventListener('click', () => {
        if (index <= 0) return;
        index -= 1;
        paint();
      });

      paint();

      return {
        resume() {
          paint();
        },
        destroy() {},
      };
    },
  };
}
