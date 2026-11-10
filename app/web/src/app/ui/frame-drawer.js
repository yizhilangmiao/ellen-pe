// 抽屉外壳。记忆 / 相处 / 设置这三个 tab 不再换根页面，而是从右侧滑进来
// —— 聊天永远在下面没被销毁，所以草稿、滚动位置、正在流的回复全都不用自己保。
//
// 为什么是 portal：抽屉必须挂在 .ellen-app 直接子节点上，不能放进 .el-page。
// 放进页面里会被页面的 position:absolute + overflow 裁掉，且返回时需要把
// 三层 DOM 一起摘，容易漏（§3.3）。
//
// 换页硬切（0 / 30 / 60ms 三档，越低端越快），关闭即 destroy 内容视图，
// 不把三份 view 常驻在 DOM 里 —— 首屏 DOM 已经三千节点，再加三页编码就掉帧。

import { mountInto, dispose } from './router.js';

const HARD_CUT = 30; // 换内容时的遮挡时长（ms）；0 = 立即换

function focusables(root) {
  return [...root.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(
    (el) => !el.disabled && el.offsetParent !== null,
  );
}

export function createDrawer({ root, onChange } = {}) {
  const scrim = document.createElement('div');
  scrim.className = 'el-drawer-scrim';
  scrim.hidden = true;

  const panel = document.createElement('aside');
  panel.className = 'el-drawer';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.tabIndex = -1; // 一个可聚焦的东西都没有时，焦点落在抽屉本身，别留在被盖住的聊天页
  panel.hidden = true;

  const body = document.createElement('div');
  body.className = 'el-drawer-body';
  panel.append(body);
  root.append(scrim, panel);

  let node = null; // mountInto 的产物
  let openName = null;
  let guard = false; // 我们压了一条 history，返回键先关抽屉
  let opener = null; // 打开它的那个按钮，关上时焦点还回去
  let swipe = null;
  let closing = false;

  function notify() {
    if (onChange) onChange(openName);
  }

  function mount(name, params) {
    if (node) {
      dispose(node);
      node = null;
    }
    node = mountInto(name, body, params);
    // 视图的 CSS 用 .el-page:not(.is-active){display:none} 做显隐，抽屉里也得挂上，
    // 否则容器有了、内容还是 0×0（踩过：抽屉打开是空的，只有一个缺角黑块）。
    node.el.classList.add('is-active');
    if (node.handle && typeof node.handle.resume === 'function') {
      try {
        node.handle.resume();
      } catch (err) {
        console.error('[drawer] resume 失败', err);
      }
    }
  }

  function open(name, { params, from } = {}) {
    if (openName === name) return;
    opener = from || document.activeElement;
    // 换内容时先盖住 30ms 再换，避免旧页闪一下（硬切分档，不做位移动画）
    const swap = () => {
      mount(name, params);
      openName = name;
      panel.hidden = false;
      scrim.hidden = false;
      panel.classList.add('is-open');
      root.dataset.drawer = name;
      // 视图画完才可能有可聚焦元素（paint 会替换子节点），延一帧再抢焦点
      requestAnimationFrame(() => {
        const first = focusables(panel)[0];
        (first || panel).focus({ preventScroll: true });
      });
      notify();
    };
    if (openName && HARD_CUT > 0) {
      panel.classList.add('is-swapping');
      window.setTimeout(() => {
        panel.classList.remove('is-swapping');
        swap();
      }, HARD_CUT);
    } else {
      swap();
    }
    if (!guard) {
      guard = true;
      try {
        history.pushState({ ellenDrawer: name }, '');
      } catch {
        guard = false;
      }
    }
  }

  function close({ silent } = {}) {
    if (!openName || closing) return;
    closing = true;
    const name = openName;
    openName = null;
    panel.classList.remove('is-open');
    panel.hidden = true;
    scrim.hidden = true;
    delete root.dataset.drawer;
    if (node) {
      dispose(node);
      node = null;
    }
    if (opener && typeof opener.focus === 'function') {
      try {
        opener.focus({ preventScroll: true });
      } catch {
        /* 打开它的按钮可能已经不在了（比如刚切过页），忽略 */
      }
    }
    opener = null;
    if (guard && !silent) {
      guard = false;
      try {
        history.back();
      } catch {
        /* 无 history（首次进入直接开抽屉）时忽略 */
      }
    }
    closing = false;
    notify();
    return name;
  }

  function toggle(name, opts) {
    if (openName === name) return close();
    return open(name, opts);
  }

  scrim.addEventListener('click', () => close());

  // 返回键：我们压过一条 history，先吃掉这一下
  window.addEventListener('popstate', () => {
    if (guard) {
      guard = false;
      close({ silent: true });
    }
  });

  window.addEventListener('keydown', (e) => {
    if (!openName) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    // 焦点圈在抽屉里，别跑到被盖住的聊天页上
    const list = focusables(panel);
    if (!list.length) return;
    const first = list[0];
    const last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });

  // 右划关闭：宽度超过 40% 就关，否则回弹。竖向手势不抢（聊天页还要滚）
  panel.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    swipe = { x: e.clientX, y: e.clientY, dx: 0, decided: false, id: e.pointerId };
  });
  panel.addEventListener('pointermove', (e) => {
    if (!swipe || e.pointerId !== swipe.id) return;
    const dx = Math.max(0, e.clientX - swipe.x);
    const dy = Math.abs(e.clientY - swipe.y);
    if (!swipe.decided) {
      if (Math.abs(dx) < 8 && dy < 8) return;
      if (dy > dx * 1.5) {
        swipe = null; // 竖向，让页面自己滚
        return;
      }
      swipe.decided = true;
      try {
        panel.setPointerCapture(swipe.id);
      } catch {
        /* 某些 WebView 上 capture 会抛，忽略即可 */
      }
      panel.classList.add('is-dragging');
    }
    swipe.dx = dx;
    panel.style.transform = `translateX(${dx}px)`;
    scrim.style.opacity = String(Math.max(0, 1 - dx / Math.max(1, panel.offsetWidth)));
  });
  function endSwipe(e) {
    if (!swipe || (e && e.pointerId !== swipe.id)) return;
    const { dx } = swipe;
    const width = panel.offsetWidth || 1;
    swipe = null;
    panel.classList.remove('is-dragging');
    panel.style.transform = '';
    scrim.style.opacity = '';
    if (dx > width * 0.4) close();
  }
  panel.addEventListener('pointerup', endSwipe);
  panel.addEventListener('pointercancel', endSwipe);

  // 抽屉里的视图如果 push 了全屏页（设置子页、手记详情），抽屉要先让开
  function yieldToPage() {
    if (openName) close({ silent: true });
  }

  return {
    open,
    close,
    toggle,
    yieldToPage,
    isOpen: () => !!openName,
    currentName: () => openName,
    panel,
    scrim,
  };
}
