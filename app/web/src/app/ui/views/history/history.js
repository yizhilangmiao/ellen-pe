// 聊天历史：所有会话线程的列表，点一条切过去。
//
// 版式照基线 `_verify/ui-baseline/05-history.png`：开始新聊天（主按钮）+ 搜索 + 线程卡。
// 数据来自 `data-heads` 里 kind=message 的分组，不额外存"会话表"——
// 旧包也没有独立的 thread 记录（真机上只有 2 条 thread，且字段只有 title/createdAt）。
import { s } from '../../../strings.zh.js';
import { iconEl } from '../../icons.js';
import { listLatest } from '../../../core/store/library.js';
import { setCurrentThread } from '../../../core/store/records.js';
import './history.css';

function shortTime(at) {
  if (!at) return '';
  const d = new Date(Number(at));
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const p = (n) => String(n).padStart(2, '0');
  if (sameDay) return `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
}

/** 把消息按线程聚起来，顺带留最后一条的预览。 */
async function collect() {
  const rows = await listLatest('message', { limit: 400 });
  const map = new Map();
  for (const r of rows) {
    const tid = r.threadId || (r.value && r.value.threadId) || '';
    if (!tid) continue;
    const at = Number(r.value && r.value.createdAt) || Number(r.at) || 0;
    const cur = map.get(tid) || { threadId: tid, count: 0, lastAt: 0, preview: '', lastRole: '' };
    cur.count += 1;
    if (at >= cur.lastAt) {
      cur.lastAt = at;
      cur.preview = String((r.value && r.value.text) || '').replace(/\s+/g, ' ').slice(0, 60);
      cur.lastRole = (r.value && r.value.role) || '';
    }
    map.set(tid, cur);
  }
  return [...map.values()].sort((a, b) => b.lastAt - a.lastAt);
}

export function createHistoryView({ state } = {}) {
  let root = null;
  let items = [];
  let keyword = '';
  let currentThread = '';

  async function reload() {
    if (!root) return;
    try {
      items = await collect();
      currentThread = (state && state.getThreadId && state.getThreadId()) || '';
    } catch (err) {
      console.error('[history] 读会话失败', err);
      items = [];
    }
    render();
  }

  function render() {
    if (!root) return;
    const list = root.querySelector('.el-history-list');
    if (!list) return;
    list.innerHTML = '';

    const shown = keyword
      ? items.filter(
          (it) => it.preview.includes(keyword) || it.threadId.includes(keyword) || '和艾莲'.includes(keyword)
        )
      : items;

    if (!shown.length) {
      const box = document.createElement('div');
      box.className = 'el-history-empty';
      box.textContent = keyword ? '没有对得上的会话。' : '还没有聊过。回聊天页说一句就有了。';
      list.appendChild(box);
      return;
    }

    for (const it of shown) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'el-history-card';
      if (it.threadId === currentThread) card.classList.add('is-current');
      card.dataset.threadId = it.threadId;

      const top = document.createElement('div');
      top.className = 'el-history-card-top';
      const name = document.createElement('span');
      name.className = 'el-history-name';
      name.textContent = s('history.threadName');
      const time = document.createElement('span');
      time.className = 'el-history-time';
      time.textContent = shortTime(it.lastAt);
      top.append(name, time);

      const preview = document.createElement('p');
      preview.className = 'el-history-preview';
      preview.textContent = (it.lastRole === 'user' ? '我：' : '') + (it.preview || '（这一段没有文字）');

      const meta = document.createElement('span');
      meta.className = 'el-history-count';
      meta.textContent = s('history.count').replace('{n}', String(it.count));

      card.append(top, preview, meta);
      card.addEventListener('click', () => open(it));
      list.appendChild(card);
    }
  }

  async function open(it) {
    if (!state) return;
    try {
      await setCurrentThread(it.threadId);
      await state.reload();
      const { show } = await import('../../router.js');
      show('chat');
    } catch (err) {
      console.error('[history] 切线程失败', err);
    }
  }

  async function newThread() {
    if (!state) return;
    const { uuid } = await import('../../../core/store/records.js');
    const id = `thread:${uuid()}`;
    await setCurrentThread(id);
    await state.reload();
    const { show } = await import('../../router.js');
    show('chat');
  }

  return {
    mount(el) {
      root = el;
      el.classList.add('el-scroll-page', 'el-history-page');
      root.innerHTML = '';

      const head = document.createElement('div');
      head.className = 'el-history-head';
      const eyebrow = document.createElement('p');
      eyebrow.className = 'el-eyebrow';
      eyebrow.textContent = s('history.eyebrow');
      const title = document.createElement('h1');
      title.className = 'el-page-title';
      title.textContent = s('history.title');
      const sub = document.createElement('p');
      sub.className = 'el-page-subtitle';
      sub.textContent = s('history.subtitle');
      head.append(eyebrow, title, sub);

      const actions = document.createElement('div');
      actions.className = 'el-history-actions';

      const startBtn = document.createElement('button');
      startBtn.type = 'button';
      startBtn.className = 'el-primary el-history-start';
      startBtn.append(iconEl('plus'), Object.assign(document.createElement('span'), { textContent: s('history.start') }));
      startBtn.addEventListener('click', newThread);

      const search = document.createElement('input');
      search.type = 'search';
      search.className = 'el-history-search';
      search.placeholder = s('history.search');
      search.setAttribute('aria-label', s('history.search'));
      search.addEventListener('input', () => {
        keyword = search.value.trim();
        render();
      });

      actions.append(startBtn, search);

      const list = document.createElement('div');
      list.className = 'el-history-list';

      root.append(head, actions, list);
      reload();
      return { resume: () => reload() };
    },
  };
}
