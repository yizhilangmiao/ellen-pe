// 动效降级收口（批 4 · §5.3）。三件事：
//   1. 系统「减弱动效」开着 → 给根节点加 .reduce-ui-motion；
//   2. 首帧测 rAF 间隔，连续 30 帧 > 33ms（≈ 30fps 以下）→ 判低端机，自动降级并记住；
//   3. 键盘弹起时打 data-input="keyboard"（浮层类循环动效在打字时停掉）。
//
// 用 0.01ms 而不是 animation:none：CSS 里若有等 animationend 的逻辑，none 会让它永远不触发。

const KEY = 'ellen.ui.motion';
const SLOW_FRAME_MS = 33;
const SLOW_STREAK = 30;

function applyReduce(root, on, remember) {
  root.classList.toggle('reduce-ui-motion', !!on);
  if (on && remember) {
    try {
      localStorage.setItem(KEY, 'reduce');
    } catch {
      /* 隐私模式下 localStorage 可能抛，那就只这次生效 */
    }
  }
}

/** 测 60 帧，连续 30 帧超 33ms 就永久降级（只测一次，别每帧都测）。 */
function probeFrames(root) {
  let slow = 0;
  let frames = 0;
  let last = 0;
  const step = (t) => {
    if (last) {
      const dt = t - last;
      slow = dt > SLOW_FRAME_MS ? slow + 1 : 0;
      frames += 1;
      if (slow >= SLOW_STREAK) {
        applyReduce(root, true, true);
        return;
      }
      // 只在前 90 帧内观测：再往后是用户操作造成的长帧，不代表机器性能
      if (frames > 90) return;
    }
    last = t;
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

export function initMotionGuard(root) {
  let remembered = false;
  try {
    remembered = localStorage.getItem(KEY) === 'reduce';
  } catch {
    remembered = false;
  }

  const mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  if ((mq && mq.matches) || remembered) applyReduce(root, true, false);
  if (mq && typeof mq.addEventListener === 'function') {
    mq.addEventListener('change', (e) => {
      if (e.matches) applyReduce(root, true, false);
    });
  }

  probeFrames(root);

  // 键盘弹起：visualViewport 高度掉到 75% 以下就当键盘在
  const vv = window.visualViewport;
  if (vv) {
    const base = vv.height;
    const sync = () => {
      const shrunk = vv.height < base * 0.75;
      if (shrunk) root.dataset.input = 'keyboard';
      else delete root.dataset.input;
    };
    vv.addEventListener('resize', sync);
  }

  return {
    reduce: () => applyReduce(root, true, true),
    isReduced: () => root.classList.contains('reduce-ui-motion'),
  };
}
