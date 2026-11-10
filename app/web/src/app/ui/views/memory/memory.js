// 记忆页（底栏「回忆」）。
//
// 版式照 `_verify/ui-baseline/08-memory-tab.png`：
//   eyebrow → h1 → 副标题 → 三段（我们的回忆 / 记忆 / 我眼里的你）
//   → 胶囊组（她的过去 / 共同经历 / 星图）→ 一行说明 → 米白记忆卡片
//
// 数据来自本地库（`memory` / `journal` 两类记录），不再是空壳。
import { s } from '../../../strings.zh.js';
import { iconEl } from '../../icons.js';
import { listLatest } from '../../../core/store/library.js';
import { push } from '../../router.js';
import './memory.css';
import './memory-calendar.css';

function dayLabel(at) {
  const d = new Date(at || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const WEEK_HEADS = ['日', '一', '二', '三', '四', '五', '六'];

/** 把 journal 列表按 `YYYY-MM-DD` 建索引：day → 列表下标（点日历格直接跳那一篇）。 */
function byDay(rows) {
  const map = new Map();
  rows.forEach((r, i) => {
    const day = (r.value && r.value.day) || dayLabel(r.at);
    if (day && !map.has(day)) map.set(day, i);
  });
  return map;
}

function ymd(y, m, d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${y}-${pad(m + 1)}-${pad(d)}`;
}

/**
 * 手记日历（照旧包 `04-memory.png`：月份箭头 + 星期行 + 日格 + 最近一篇）。
 * 只有写过手记的日子是可点的，其余灰掉 —— 点空日子什么也不发生，别给假反馈。
 */
function journalCalendar(rows, cursor, onOpen, onShiftMonth) {
  const days = byDay(rows);
  const box = document.createElement('div');
  box.className = 'el-journal-cal';

  const head = document.createElement('div');
  head.className = 'el-journal-cal-head';

  const prev = document.createElement('button');
  prev.type = 'button';
  prev.className = 'el-journal-month-arrow';
  prev.dataset.journalControl = 'previous';
  prev.textContent = '‹';
  prev.addEventListener('click', () => onShiftMonth(-1));

  const label = document.createElement('span');
  label.className = 'el-journal-cal-title';
  label.textContent = `${cursor.getFullYear()} 年 ${cursor.getMonth() + 1} 月`;

  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'el-journal-month-arrow';
  next.dataset.journalControl = 'next';
  next.textContent = '›';
  next.addEventListener('click', () => onShiftMonth(1));
  // 不给翻到未来的月份：那边一定没有手记
  const now = new Date();
  const atLatestMonth =
    cursor.getFullYear() === now.getFullYear() && cursor.getMonth() === now.getMonth();
  next.disabled = atLatestMonth;

  head.append(prev, label, next);

  const week = document.createElement('div');
  week.className = 'el-journal-week';
  for (const w of WEEK_HEADS) {
    const cell = document.createElement('span');
    cell.className = 'el-journal-week-cell';
    cell.textContent = w;
    week.append(cell);
  }

  const grid = document.createElement('div');
  grid.className = 'el-journal-grid';
  const y = cursor.getFullYear();
  const m = cursor.getMonth();
  const firstDow = new Date(y, m, 1).getDay();
  const total = new Date(y, m + 1, 0).getDate();
  const todayKey = dayLabel(Date.now());

  for (let i = 0; i < firstDow; i += 1) {
    const filler = document.createElement('span');
    filler.className = 'el-journal-day-cell is-blank';
    grid.append(filler);
  }
  for (let d = 1; d <= total; d += 1) {
    const key = ymd(y, m, d);
    const idx = days.get(key);
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'el-journal-day-cell';
    cell.dataset.day = key;
    cell.dataset.status = idx === undefined ? 'empty' : 'filled';
    cell.textContent = String(d);
    if (key === todayKey) cell.classList.add('is-today');
    if (idx !== undefined) {
      cell.classList.add('has-entry');
      cell.addEventListener('click', () => onOpen(idx));
    } else {
      cell.disabled = true;
    }
    grid.append(cell);
  }

  box.append(head, week, grid);
  return box;
}
function memoryCard(item, onOpen) {
  const card = document.createElement('article');
  card.className = 'el-memory-card';
  card.dataset.memoryId = item.headId;

  const mark = document.createElement('div');
  mark.className = 'el-memory-mark';
  mark.append(iconEl('book'));

  const title = document.createElement('h2');
  title.className = 'el-memory-title';
  const v = item.value || {};
  title.textContent = v.title || v.subject || '一段回忆';

  const body = document.createElement('p');
  body.className = 'el-memory-body';
  body.textContent = v.summary || v.body || '';

  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'el-memory-more';
  more.innerHTML = `${s('memory.openMemory')}<span class="el-memory-arrow">→</span>`;
  more.addEventListener('click', () => {
    if (onOpen) onOpen(item);
    else card.classList.toggle('is-expanded');
  });

  card.append(mark, title, body, more);
  return card;
}

/** 「最近一篇」大卡（旧包 `button.el-journal-latest`）：日历下面那一眼就能看到的最新手记。 */
function latestJournal(item, onOpen) {
  const v = item.value || {};
  const card = document.createElement('article');
  card.className = 'el-journal-card el-journal-latest';

  const day = document.createElement('div');
  day.className = 'el-journal-day';
  day.textContent = v.day || dayLabel(item.at);

  const title = document.createElement('h2');
  title.className = 'el-journal-title';
  title.textContent = v.title || s('journal.untitled');

  const body = document.createElement('p');
  body.className = 'el-journal-body';
  body.textContent = v.diary || '';

  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'el-memory-more';
  more.innerHTML = `${s('memory.openMemory')}<span class="el-memory-arrow">→</span>`;
  more.addEventListener('click', onOpen);

  card.append(day, title, body, more);
  return card;
}
function journalCard(item, onOpen) {
  const v = item.value || {};
  const card = document.createElement('article');
  card.className = 'el-journal-card';
  card.dataset.journalDay = v.day || dayLabel(item.at);

  const day = document.createElement('div');
  day.className = 'el-journal-day';
  day.textContent = v.day || dayLabel(item.at);

  const title = document.createElement('h2');
  title.className = 'el-journal-title';
  title.textContent = v.title || '这一天';

  const body = document.createElement('p');
  body.className = 'el-journal-body';
  body.textContent = v.diary || v.thoughts || '';

  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'el-memory-more';
  more.innerHTML = `${s('memory.openMemory')}<span class="el-memory-arrow">→</span>`;
  more.addEventListener('click', () => {
    if (onOpen) onOpen(item);
    else card.classList.toggle('is-expanded');
  });

  card.append(day, title, body, more);
  return card;
}

export function createMemoryView() {
  return {
    mount(el) {
      el.classList.add('el-scroll-page', 'el-memory-page');

      const eyebrow = document.createElement('div');
      eyebrow.className = 'el-eyebrow';
      eyebrow.textContent = s('memory.eyebrow');

      const title = document.createElement('h1');
      title.className = 'el-page-title';
      title.textContent = s('memory.title');

      const subtitle = document.createElement('p');
      subtitle.className = 'el-page-subtitle';
      subtitle.textContent = s('memory.subtitle');

      // 三段
      const pages = document.createElement('div');
      pages.className = 'el-segments';
      const pageDefs = [
        ['daily', s('memory.pageDaily')],
        ['memories', s('memory.pageMemories')],
        ['understanding', s('memory.pageUnderstanding')],
      ];
      const pageBtns = pageDefs.map(([id, label]) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'el-segment';
        b.dataset.memoryPage = id;
        b.textContent = label;
        pages.append(b);
        return b;
      });

      // 胶囊
      const groups = document.createElement('div');
      groups.className = 'el-recall-groups';
      const groupDefs = [
        ['past', s('memory.past')],
        ['shared', s('memory.shared')],
        ['stars', s('memory.stars')],
      ];
      const groupBtns = groupDefs.map(([id, label]) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'el-recall-group';
        b.dataset.recallGroup = id;
        b.textContent = label;
        groups.append(b);
        return b;
      });

      const hint = document.createElement('p');
      hint.className = 'el-section-hint';

      const list = document.createElement('div');
      list.className = 'el-memory-list';

      el.append(eyebrow, title, subtitle, pages, groups, hint, list);

      // 手记列表分页：一次只往 DOM 里塞 60 张。
      // 为什么：500 篇的库里一次性渲染 401 张卡片，DOM 两千多个节点、页面高 61000 px，
      // 低端机上滚动会掉帧；而且原来写死 limit:400，超过 400 篇的老手记在列表里根本到不了。
      const JOURNAL_PAGE = 60;
      const state = { page: 'memories', group: 'past', loading: false, month: null, journalRows: null, journalShown: 0 };

      function paintButtons() {
        for (const b of pageBtns) b.classList.toggle('is-active', b.dataset.memoryPage === state.page);
        for (const b of groupBtns) b.classList.toggle('is-active', b.dataset.recallGroup === state.group);
        groups.hidden = state.page !== 'memories';
      }

      function emptyBox(text, sub) {
        const box = document.createElement('div');
        box.className = 'el-memory-empty';
        const t = document.createElement('div');
        t.className = 'el-memory-empty-title';
        t.textContent = text;
        box.append(t);
        if (sub) {
          const p = document.createElement('div');
          p.className = 'el-memory-empty-sub';
          p.textContent = sub;
          box.append(p);
        }
        return box;
      }

      // 把「我们的回忆」的日常视图画出来：日历 + 最新一篇大卡 + 前 N 张卡 + 「再多看几篇」
      // 点「再多看几篇」只往末尾追加，不重建整棵树（重建会把滚动位置甩回顶部）。
      function paintDaily() {
        const rows = state.journalRows || [];
        list.replaceChildren();
        if (!rows.length) {
          list.append(emptyBox(s('memory.empty'), s('memory.journalEmpty')));
          return;
        }
        const open = (i) => push('journal', { items: rows, index: i });
        // 第一次进来时把日历翻到最新那篇所在的月份
        if (!state.month) {
          const newest = rows[0].value && rows[0].value.day ? rows[0].value.day : dayLabel(rows[0].at);
          const d = new Date(`${newest}T00:00:00`);
          state.month = new Date(d.getFullYear(), d.getMonth(), 1);
        }
        list.append(
          journalCalendar(rows, state.month, open, (step) => {
            state.month = new Date(state.month.getFullYear(), state.month.getMonth() + step, 1);
            paintDaily();
          })
        );
        list.append(latestJournal(rows[0], () => open(0)));
        const allHead = document.createElement('p');
        allHead.className = 'el-journal-all-head';
        allHead.textContent = s('memory.journalAll');
        list.append(allHead);

        const cards = document.createElement('div');
        cards.className = 'el-journal-cards';
        list.append(cards);

        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'el-journal-more';

        function syncMore() {
          const shown = state.journalShown;
          const left = rows.length - shown;
          if (left <= 0) {
            more.remove();
            return;
          }
          more.textContent = s('memory.journalMore').replace('{n}', String(left));
          if (!more.isConnected) list.append(more);
        }

        function grow() {
          const from = state.journalShown;
          const to = Math.min(from + JOURNAL_PAGE, rows.length);
          const frag = document.createDocumentFragment();
          for (let i = from; i < to; i += 1) frag.append(journalCard(rows[i], () => open(i)));
          cards.append(frag);
          state.journalShown = to;
          syncMore();
        }

        more.addEventListener('click', grow);
        grow();
      }

      async function load() {
        if (state.loading) return;
        state.loading = true;
        list.replaceChildren();
        const loading = document.createElement('div');
        loading.className = 'el-memory-loading';
        loading.textContent = s('memory.loading');
        list.append(loading);
        paintButtons();

        try {
          if (state.page === 'memories') {
            if (state.group === 'past') {
              hint.textContent = s('memory.pastHint');
              const rows = await listLatest('memory', { limit: 50 });
              list.replaceChildren();
              if (!rows.length) {
                list.append(emptyBox(s('memory.empty'), s('memory.emptyHint')));
              } else {
                for (const r of rows) list.append(memoryCard(r));
              }
            } else if (state.group === 'shared') {
              hint.textContent = s('memory.sharedHint');
              list.replaceChildren(emptyBox(s('memory.empty'), s('memory.sharedHint')));
            } else {
              hint.textContent = s('memory.starsHint');
              list.replaceChildren(emptyBox(s('memory.empty'), s('memory.starsHint')));
            }
          } else if (state.page === 'daily') {
            hint.textContent = '';
            // limit:0 = 全量。日历要标出「哪天有手记」，必须有全部日期；
            // DOM 只渲染前 state.journalShown 张（见 paintDaily）。
            const rows = await listLatest('journal', { limit: 0 });
            state.journalRows = rows;
            state.journalShown = 0; // 由 paintDaily 里的 grow() 从 0 开始铺第一批
            paintDaily();
          } else {
            hint.textContent = s('memory.understandingHint');
            list.replaceChildren(emptyBox(s('memory.empty'), s('memory.understandingHint')));
          }
        } catch (err) {
          console.error('[memory] 读取失败', err);
          list.replaceChildren(emptyBox('读不出来了', String((err && err.message) || err)));
        } finally {
          state.loading = false;
        }
      }

      for (const b of pageBtns) {
        b.addEventListener('click', () => {
          if (state.page === b.dataset.memoryPage) return;
          state.page = b.dataset.memoryPage;
          load();
        });
      }
      for (const b of groupBtns) {
        b.addEventListener('click', () => {
          if (state.group === b.dataset.recallGroup) return;
          state.group = b.dataset.recallGroup;
          load();
        });
      }

      paintButtons();
      load();

      return {
        resume() {
          load();
        },
        destroy() {},
      };
    },
  };
}
