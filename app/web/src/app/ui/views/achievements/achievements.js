// 徽章墙（`achievements` 路由）。
//
// 一屏网格：12 枚徽章，解锁的亮、没解锁的灰，顶上一条 n / 12 的进度。
// 点一枚展开它自己的小卡：解锁条件（hint）+ 解锁时间（或「还没解锁」）。
//
// 数据：`props.list / props.progress`（Lead 注入）或自己读 `core/achievements.js`；
// 模块没落地就显示空态，别让整页崩。
import { s } from '../../../strings.zh.js';
import { iconEl } from '../../icons.js';
import './achievements.css';

let corePromise = null;
function achCore() {
  if (!corePromise) {
    corePromise = import('../../../core/achievements.js').catch((err) => {
      console.warn('[achievements] core/achievements.js 还不可用', err);
      return null;
    });
  }
  return corePromise;
}

const pad2 = (n) => String(n).padStart(2, '0');

function dateText(at) {
  const n = Number(at) || 0;
  if (!n) return '';
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
}

/** 缺键兜底：s() 会把键名原样吐回来，别让它出现在屏幕上。 */
function t(key, fallback) {
  const got = s(key);
  return got === key ? fallback : got;
}

export function createAchievementsView({ state } = {}) {
  let root = null;
  let props = {};
  let badges = [];
  let total = 0;
  let unlockedCount = 0;
  let selectedId = null;
  let busy = false;
  let disposed = false;

  // ── 骨架 ──────────────────────────────────────────────────────────
  function buildShell(el) {
    el.classList.add('el-scroll-page', 'el-achievements-page');
    while (el.firstChild) el.removeChild(el.firstChild);

    const head = document.createElement('header');
    head.className = 'el-ach-head';

    const title = document.createElement('h1');
    title.className = 'el-page-title';
    title.textContent = s('ach.title');

    const subtitle = document.createElement('p');
    subtitle.className = 'el-page-subtitle';
    subtitle.textContent = s('ach.subtitle');

    const count = document.createElement('p');
    count.className = 'el-ach-count';

    head.append(title, subtitle, count);

    const grid = document.createElement('div');
    grid.className = 'el-ach-grid';

    const detail = document.createElement('section');
    detail.className = 'el-ach-detail';
    detail.hidden = true;

    el.append(head, grid, detail);
    return { head, count, grid, detail };
  }

  function paintCount(countEl) {
    const n = Number(unlockedCount) || 0;
    const all = Number(total) || badges.length || 0;
    const text = s('ach.count');
    countEl.textContent = text === 'ach.count' ? `${n} / ${all}` : text.replace('{n}', String(n)).replace('{total}', String(all));
  }

  // ── 网格 ──────────────────────────────────────────────────────────
  function paintGrid(grid) {
    while (grid.firstChild) grid.removeChild(grid.firstChild);

    if (!badges.length) {
      const empty = document.createElement('p');
      empty.className = 'el-ach-empty';
      empty.textContent = s('ach.empty');
      grid.append(empty);
      return;
    }

    badges.forEach((badge, index) => {
      const unlocked = Number(badge.unlockedAt) > 0;

      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'el-ach-cell';
      cell.classList.toggle('is-unlocked', unlocked);
      cell.classList.toggle('is-locked', !unlocked);
      cell.classList.toggle('is-selected', badge.id === selectedId);

      const seal = document.createElement('span');
      seal.className = 'el-ach-seal';
      if (unlocked) {
        // 解锁的盖一枚对勾；没解锁的只留序号，别用锁图标暗示「打不开」
        seal.append(iconEl('check'));
      } else {
        seal.textContent = String(index + 1);
      }

      const name = document.createElement('span');
      name.className = 'el-ach-name';
      name.textContent = unlocked ? badge.title : s('ach.locked');

      cell.append(seal, name);
      cell.addEventListener('click', () => {
        selectedId = selectedId === badge.id ? null : badge.id;
        paintGrid(grid);
        paintDetail();
      });
      grid.append(cell);
    });
  }

  // ── 单个徽章小卡 ──────────────────────────────────────────────────
  function paintDetail() {
    if (!root || !root._detail) return;
    const detail = root._detail;
    while (detail.firstChild) detail.removeChild(detail.firstChild);

    const badge = badges.find((b) => b.id === selectedId);
    if (!badge) {
      detail.hidden = true;
      return;
    }
    detail.hidden = false;

    const unlocked = Number(badge.unlockedAt) > 0;

    const title = document.createElement('p');
    title.className = 'el-ach-detail-title';
    title.textContent = unlocked ? badge.title : s('ach.locked');

    const hint = document.createElement('p');
    hint.className = 'el-ach-detail-hint';
    hint.textContent = String(badge.hint || '');

    const status = document.createElement('p');
    status.className = 'el-ach-detail-status';
    status.textContent = unlocked
      ? t('ach.unlockedAt', '{date} 解锁').replace('{date}', dateText(badge.unlockedAt))
      : s('ach.locked');

    detail.append(title, hint, status);
  }

  // ── 数据 ──────────────────────────────────────────────────────────
  async function refresh() {
    if (!root || busy || disposed) return;
    busy = true;
    try {
      let list = Array.isArray(props.list) ? props.list.slice() : null;
      let prog = props.progress || null;
      if (!list) {
        const mod = await achCore();
        if (mod && typeof mod.list === 'function') {
          try {
            list = await mod.list();
          } catch (err) {
            console.warn('[achievements] 读徽章失败', err);
          }
        }
        if (!prog && mod && typeof mod.progress === 'function') {
          try {
            prog = await mod.progress();
          } catch (err) {
            prog = null;
          }
        }
      }
      if (disposed) return;
      badges = Array.isArray(list) ? list : [];
      total = Number(prog && prog.total) || badges.length;
      unlockedCount = Number(prog && prog.unlocked);
      if (!Number.isFinite(unlockedCount)) {
        unlockedCount = badges.filter((b) => Number(b.unlockedAt) > 0).length;
      }
      if (!root) return;
      paintGrid(root._grid);
      if (root._count) paintCount(root._count);
      paintDetail();
    } finally {
      busy = false;
    }
  }

  return {
    id: 'achievements',

    mount(el, mountProps = {}) {
      props = mountProps || {};
      root = el;
      disposed = false;
      selectedId = props.selectedId || null;

      const shell = buildShell(el);
      root._grid = shell.grid;
      root._count = shell.count;
      root._detail = shell.detail;

      refresh().catch((err) => console.warn('[achievements] 首屏加载失败', err));

      return {
        resume() {
          refresh().catch((err) => console.warn('[achievements] resume 失败', err));
        },
        /** Lead 自己跑完 evaluate() 之后把新列表推过来。 */
        setList(list, prog) {
          props.list = Array.isArray(list) ? list.slice() : null;
          if (prog) props.progress = prog;
          return refresh();
        },
        refresh() {
          return refresh();
        },
        destroy() {
          disposed = true;
          badges = [];
          selectedId = null;
          props = {};
          if (root) {
            root._grid = null;
            root._count = null;
            root._detail = null;
          }
          root = null;
        },
      };
    },
  };
}
