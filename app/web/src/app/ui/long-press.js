// 长按手势（共用）。
//
// 从 chat 那边验证过的那一套搬过来的：0.5.19 修「长按弹不出菜单」时踩到的坑
// 都在这里体现，别再各写一份：
//   ① 450ms 起弹，位移超过 12 CSS px 当成滚动放弃（8 太紧，手抖的人按不出来）；
//   ② pointercancel 不无条件取消 —— WebView 把长按接成系统取词、或系统手势介入时
//      都会发它，手指其实还按着原处；只有它带的坐标已经离开原点超过阈值才算「交给滚动了」；
//   ③ pointerleave 只对鼠标算数，触屏上它常因容器重排误发；
//   ④ 按住期间只要真滚了一次就作废（scroll 不冒泡，挂 document 捕获阶段）；
//   ⑤ 没有 PointerEvent 的老 WebView 用 touchstart 兜底。
//
// 用法：attachLongPress(node, (event) => {...}, { ms, slop })
// 返回一个 detach()，节点被替换时记得调（不调也只是白留一个监听，节点没了就回收了）。

const DEFAULTS = { ms: 450, slop: 12 };

export function attachLongPress(node, onLongPress, options = {}) {
  if (!node || typeof onLongPress !== 'function') return () => {};
  const ms = Number(options.ms) > 0 ? Number(options.ms) : DEFAULTS.ms;
  const slop = Number(options.slop) > 0 ? Number(options.slop) : DEFAULTS.slop;
  const hasPointer = typeof window.PointerEvent === 'function';

  let timer = 0;
  let origin = null;

  function cancel() {
    if (timer) {
      clearTimeout(timer);
      timer = 0;
    }
    origin = null;
    document.removeEventListener('scroll', cancel, { capture: true });
  }

  function start(x, y) {
    cancel();
    origin = { x, y };
    document.addEventListener('scroll', cancel, { capture: true, passive: true });
    timer = setTimeout(() => {
      timer = 0;
      origin = null;
      document.removeEventListener('scroll', cancel, { capture: true });
      onLongPress();
    }, ms);
  }

  function move(x, y) {
    if (!origin) return;
    if (Math.abs(x - origin.x) > slop || Math.abs(y - origin.y) > slop) cancel();
  }

  const onPointerDown = (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    start(e.clientX, e.clientY);
  };
  const onPointerMove = (e) => move(e.clientX, e.clientY);
  const onPointerCancel = (e) => move(e.clientX, e.clientY);
  const onPointerLeave = (e) => {
    if (e.pointerType === 'mouse') cancel();
  };
  const onTouchStart = (e) => {
    if (e.touches.length !== 1) return cancel();
    start(e.touches[0].clientX, e.touches[0].clientY);
  };
  const onTouchMove = (e) => {
    if (!e.touches.length) return;
    move(e.touches[0].clientX, e.touches[0].clientY);
  };

  node.addEventListener('pointerdown', onPointerDown);
  node.addEventListener('pointermove', onPointerMove);
  node.addEventListener('pointerup', cancel);
  node.addEventListener('pointercancel', onPointerCancel);
  node.addEventListener('pointerleave', onPointerLeave);

  if (!hasPointer) {
    node.addEventListener('touchstart', onTouchStart, { passive: true });
    node.addEventListener('touchmove', onTouchMove, { passive: true });
    node.addEventListener('touchend', cancel);
    node.addEventListener('touchcancel', cancel);
  }

  return function detach() {
    cancel();
    node.removeEventListener('pointerdown', onPointerDown);
    node.removeEventListener('pointermove', onPointerMove);
    node.removeEventListener('pointerup', cancel);
    node.removeEventListener('pointercancel', onPointerCancel);
    node.removeEventListener('pointerleave', onPointerLeave);
    node.removeEventListener('touchstart', onTouchStart);
    node.removeEventListener('touchmove', onTouchMove);
    node.removeEventListener('touchend', cancel);
    node.removeEventListener('touchcancel', cancel);
  };
}
