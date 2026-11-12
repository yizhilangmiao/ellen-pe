// 星图（`starmap` 路由）· 竖版「时间星河」。
//
// 定稿口径（老大 2026-11-12）：手机上要回答的是「她最近记住了什么」，不是「我的记忆
// 拓扑长什么样」。所以这里不是圆团、也不是周列，是一条从上往下、越往下越早的河：
//
//   · 中心星在顶部（视口高 1/6 处），樱粉；
//   · 记忆点统一暖白，只有「她在意的事」用一点青绿；
//   · 每 4~6 条一道很淡的时间刻度，只作分隔；
//   · 同组的在河的同侧，组内相邻两点用弧线相连；
//   · 越久远越暗越小；
//   · 上下拖 = 浏览（原生滚动，不是旋转球）；点一下 → 底部滑出卡片；
//   · 双指缩放保留，但不宣传 —— 提示只写「上下滑动 · 点开看看」。
//
// 实现：坐标全在 `core/starmap.js#layoutRiver` 算好（能 node 验算），视图只填空。
// 画布固定=视口大小，滚动时按 scrollTop 平移重画 —— 不用一张 13000px 高的巨型 canvas
// （安卓 WebView 单边超过 16384 会直接丢画面），400 个点重画一次不到 10ms。
import { s } from '../../../strings.zh.js';
import './starmap.css';

const KINDS = ['chat', 'journal', 'memory', 'letter'];

let corePromise = null;
let affectPromise = null;
function starmapCore() {
  if (!corePromise) {
    corePromise = import('../../../core/starmap.js').catch((err) => {
      console.warn('[starmap] core/starmap.js 还不可用', err);
      return null;
    });
  }
  return corePromise;
}

// 排期 E5-③：中心星（整条带的「核」）颜色跟着情绪档位走。
// 只染这一颗；事件星那套随机色是专门要的（starmap.js:190 那段注释），混进来就分不清谁是谁。
const BAND_TINT = {
  inner: '#9aa6bd',
  hint: '#c9a7c4',
  ask: '#e78ba6',
  approach: '#f27a97',
  direct: '#ff6b86',
};

function affectCore() {
  if (!affectPromise) {
    affectPromise = import('../../../core/affect.js').catch((err) => {
      console.warn('[starmap] core/affect.js 还不可用', err);
      return null;
    });
  }
  return affectPromise;
}

function t(key, fallback) {
  const got = s(key);
  return got === key ? fallback : got;
}

function dayText(day) {
  const m = String(day || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(day || '');
  return `${Number(m[2])} 月 ${Number(m[3])} 日`;
}

function kindLabel(kind) {
  if (kind === 'journal') return t('starmap.legendJournal', '手记');
  if (kind === 'memory') return t('starmap.legendMemory', '她在意的事');
  if (kind === 'letter') return t('starmap.legendLetter', '信');
  return t('starmap.legendChat', '聊天');
}

export function createStarmapView({ state } = {}) {
  let root = null;
  let props = {};
  let stage = null;
  let viewport = null;
  let spacer = null;
  let canvas = null;
  let ctx = null;
  let chipBar = null;
  let sheet = null;
  let hintEl = null;
  let emptyEl = null;

  let data = null; // layoutRiver 结果
  let points = [];
  let dust = []; // 背景星尘：给「场」，不是装饰
  let nebulae = []; // 星云雾团：让带子有体积
  let only = null; // 只看某组
  // 点开一颗星时把它的「联系」点亮，其余的压下去 —— 这几笔才是这张图的意义所在
  let focus = null;
  let clusterDrawn = 0;
  let clusterSeen = 0;
  let clusterLast = null;
  let zoom = 1;
  // 倍率到多少才把星星旁边的字放出来。1.25 ≈ 双指稍微张开一点；
  // 低于它一律不画，免得默认状态就糊成一片小字。
  const LABEL_ZOOM = 1.25;
  let dpr = 1;
  let vw = 0;
  let vh = 0;
  let unit = 1; // 设计宽 392 → 实际宽
  let scrollTop = 0;
  let padTop = 0;
  let contentH = 0;
  let colors = {};
  let centerColor = null; // 今日情绪档位给中心星染的色；读不到就用 colors.pink
  let lastTapAt = 0;

  let rafId = 0;
  let destroyed = false;

  // ── 骨架 ────────────────────────────────────────────────────────
  function buildShell(el) {
    el.classList.add('el-scroll-page', 'el-starmap-page');
    while (el.firstChild) el.removeChild(el.firstChild);

    const head = document.createElement('header');
    head.className = 'el-starmap-head';

    const eyebrow = document.createElement('p');
    eyebrow.className = 'el-eyebrow';
    eyebrow.textContent = t('starmap.eyebrow', 'OUR CONSTELLATION');

    const title = document.createElement('h1');
    title.className = 'el-page-title';
    title.textContent = t('starmap.title', '我们的星图');

    const subtitle = document.createElement('p');
    subtitle.className = 'el-page-subtitle';
    subtitle.textContent = t('starmap.subtitle', '她记得的事，按时间往下排。');

    head.append(eyebrow, title, subtitle);

    chipBar = document.createElement('div');
    chipBar.className = 'el-river-chips';

    stage = document.createElement('div');
    stage.className = 'el-river-stage';

    viewport = document.createElement('div');
    viewport.className = 'el-river-viewport';

    spacer = document.createElement('div');
    spacer.className = 'el-river-spacer';

    canvas = document.createElement('canvas');
    canvas.className = 'el-river-canvas';
    canvas.setAttribute('aria-label', t('starmap.title', '我们的星图'));

    emptyEl = document.createElement('p');
    emptyEl.className = 'el-river-empty';
    emptyEl.textContent = t('starmap.empty', '还没有星。先聊几句。');
    emptyEl.hidden = true;

    hintEl = document.createElement('p');
    hintEl.className = 'el-river-hint';
    hintEl.textContent = t('starmap.hint', '上下滑动 · 点开看看');

    // 滚动容器里只放 spacer（撑高度 + 吃手势），画布钉在上层，滚动时按 scrollTop 重画。
    // 这样避开了「sticky 元素排在 spacer 后面就粘不到顶部」的那个坑。
    viewport.append(spacer);
    stage.append(viewport, canvas, emptyEl, hintEl);

    sheet = document.createElement('section');
    sheet.className = 'el-river-sheet';
    sheet.hidden = true;

    el.append(head, chipBar, stage, sheet);

    bind();
  }

  function paintChips() {
    if (!chipBar) return;
    while (chipBar.firstChild) chipBar.removeChild(chipBar.firstChild);
    const groups = (data && data.groups) || [];
    groups.forEach((g) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'el-river-chip';
      chip.dataset.kind = g.kind;
      if (only === g.kind) chip.classList.add('is-on');
      const dot = document.createElement('i');
      dot.className = 'el-river-chip-dot';
      dot.dataset.kind = g.kind;
      const label = document.createElement('span');
      label.textContent = `${kindLabel(g.kind)} ${g.count}`;
      chip.append(dot, label);
      chip.addEventListener('click', () => {
        only = only === g.kind ? null : g.kind;
        paintChips();
        schedule();
      });
      chipBar.append(chip);
    });
  }

  // ── 尺寸 / 颜色 ─────────────────────────────────────────────────
  function readColors() {
    const el = canvas || root;
    if (!el || typeof getComputedStyle !== 'function') return;
    const cs = getComputedStyle(el);
    colors = {
      warm: (cs.getPropertyValue('--el-text') || '').trim() || '#f0edf1',
      teal: (cs.getPropertyValue('--el-success') || '').trim() || '#7fb9a6',
      pink: (cs.getPropertyValue('--el-pink') || '').trim() || '#e78ba6',
      faint: (cs.getPropertyValue('--el-muted') || '').trim() || '#8a8a96',
    };
  }

  // 老大 17:44：全是白点有点单调，让事件带点随机颜色。
  // 「随机」但不刺眼：低饱和的一套，跟暗底和樱粉中心星都不打架；
  // 同一个事件永远同一个颜色（按 ref 取模，不是每次重画换色），不然滑两下就分不清谁是谁。
  // 手记/记忆/信仍走语义色（暖白/青绿/樱粉），只有聊天事件参与随机。
  const STAR_PALETTE = ['#f0edf1', '#9fd8ef', '#c3b2ff', '#ffb98a', '#ffe39a', '#ff9fc6', '#8fe0c0'];

  function pickStarColor(seed) {
    const text = String(seed || '');
    let h = 0;
    for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) % 100003;
    return STAR_PALETTE[h % STAR_PALETTE.length];
  }

  function colorOf(kind, seed) {
    if (kind === 'memory') return colors.teal;
    if (kind === 'letter') return colors.pink;
    if (kind === 'journal') return colors.warm;
    return pickStarColor(seed);
  }

  // ── 辉光贴图 ────────────────────────────────────────────────────
  /**
   * 一颗星的「光」预渲染成一张贴图，运行时只 drawImage。
   *
   * 为什么不在每帧里画径向渐变：电脑版星图是 WebGL 点精灵，片元里算
   *   r = length(gl_PointCoord - .5) * 2
   *   core = smoothstep(1.0, 0.10, r);  halo = smoothstep(1.0, 0.0, r)
   *   a = mix(core, halo * halo, glow)
   * 即「中间一个小实心核 + 一圈二次方衰减的长尾光晕」，越到边缘越化开。
   * Canvas 2D 的 createRadialGradient 做不出这条曲线（它只给线性的 stop），
   * 硬凑会显出一圈圈的边；所以这里一次性把公式算进像素，之后贴着用。
   */
  const glowCache = new Map();

  function mixNum(a, b, t) {
    return a + (b - a) * t;
  }

  /** GLSL smoothstep：edge0 > edge1 时是反向斜坡（电脑版就是这么用的）。 */
  function smoothstep(edge0, edge1, x) {
    const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  }

  function parseHex(hex) {
    const t = String(hex || '').trim().replace('#', '');
    const full = t.length === 3 ? t.split('').map((c) => c + c).join('') : t;
    const n = parseInt(full.slice(0, 6), 16);
    if (!Number.isFinite(n)) return { r: 240, g: 237, b: 241 };
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function glowSprite(hex, glow = 0.55) {
    const key = `${hex}|${glow}`;
    const hit = glowCache.get(key);
    if (hit) return hit;

    const SIZE = 128;
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    const c2 = canvas.getContext('2d');
    const img = c2.createImageData(SIZE, SIZE);
    const data = img.data;
    const { r, g, b } = parseHex(hex);
    const gain = mixNum(1, 1.35, glow);

    for (let iy = 0; iy < SIZE; iy += 1) {
      for (let ix = 0; ix < SIZE; ix += 1) {
        const dx = (ix + 0.5) / SIZE - 0.5;
        const dy = (iy + 0.5) / SIZE - 0.5;
        const rr = Math.min(1, Math.sqrt(dx * dx + dy * dy) * 2);
        const core = smoothstep(1.0, 0.1, rr);
        const halo = smoothstep(1.0, 0.0, rr);
        const a = mixNum(core, halo * halo, glow);
        const o = (iy * SIZE + ix) * 4;
        data[o] = Math.min(255, r * gain);
        data[o + 1] = Math.min(255, g * gain);
        data[o + 2] = Math.min(255, b * gain);
        data[o + 3] = a <= 0.002 ? 0 : Math.round(a * 255);
      }
    }
    c2.putImageData(img, 0, 0);
    glowCache.set(key, canvas);
    return canvas;
  }

  /**
   * 画一颗星：先贴光晕，再压一个小实心核。
   * `radius` 是实心核的半径；光晕按 `halo` 倍撑出去（电脑版那个比例大约 4~6 倍）。
   */
  function drawStar(x, y, radius, hex, alpha, { halo = 5, glow = 0.55, core = 1 } = {}) {
    if (alpha <= 0.004) return;
    const sprite = glowSprite(hex, glow);
    const reach = Math.max(radius * halo, 6 * unit);
    ctx.globalAlpha = Math.min(1, alpha);
    ctx.drawImage(sprite, x - reach, y - reach, reach * 2, reach * 2);
    if (core > 0) {
      ctx.globalAlpha = Math.min(1, alpha * 0.95);
      ctx.fillStyle = hex;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(0.6, radius * core * 0.78), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 星尘：单列之所以显得不宏大，是因为画面里只有一条线、四周是空的。
  // 这些微点不承担信息，只承担「场」—— 沿带子铺 880 颗，远近两层，
  // 滚动时远景走 0.45 倍、近景 0.72 倍，一眼就有纵深。
  function buildDust(d) {
    const out = [];
    if (!d || !d.height) return out;
    const h = Number(d.height) || 0;
    const shear = Number(d.shear) || 0;
    const mid = Number(d.midY) || h / 2;
    let seed = 20261112;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const bell = () => (rnd() + rnd() + rnd() + rnd() - 2) * 0.9;
    // 两种星尘：贴着带子的「雾」（密、淡、宽），和整屏的「散星」（疏、更淡）。
    for (let i = 0; i < 4200; i += 1) {
      const inBand = i < 3000;
      const far = rnd() < 0.7;
      const y = rnd() * (h + 460) - 230;
      const bandX = (y - mid) * shear;
      const spread = inBand ? (far ? 78 : 44) : (far ? 300 : 200);
      const pick = rnd();
      out.push({
        x: bandX + bell() * spread,
        y,
        r: (far ? 0.38 : 0.66) * (0.55 + rnd() * 0.75),
        a: (far ? 0.16 : 0.34) * (0.45 + rnd() * 0.8) * (inBand ? 1 : 0.6),
        k: far ? 0.45 : 0.72,
        tone: pick < 0.06 ? 'teal' : (pick < 0.14 ? 'pink' : 'warm'),
      });
    }
    // 每颗事件星周围撒 3 颗「伴星」：真实星系里没有孤零零一颗亮的，
    // 这层几乎不花性能，却能把一个「点」撑成一「团」。
    const pts = Array.isArray(d.points) ? d.points : [];
    pts.forEach((p) => {
      for (let j = 0; j < 9; j += 1) {
        const ang = rnd() * Math.PI * 2;
        const dist = 9 + rnd() * 26;
        out.push({
          x: p.x + Math.cos(ang) * dist,
          y: p.y + Math.sin(ang) * dist * 1.15,
          r: 0.42 + rnd() * 0.5,
          a: 0.12 + rnd() * 0.2,
          k: 0.78 + rnd() * 0.16,
          tone: rnd() < 0.2 ? 'pink' : 'warm',
        });
      }
    });
    return out;
  }

  // 星云：几团大而极淡的色晕，沿带子铺开。不是星点，是「雾」——
  // 银河看着有体积，一半靠这个，光靠点永远是点阵。
  function buildNebulae(d) {
    const out = [];
    if (!d || !d.height) return out;
    const h = Number(d.height) || 0;
    const shear = Number(d.shear) || 0;
    const mid = Number(d.midY) || h / 2;
    let seed = 771223;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const tones = ['warm', 'pink', 'teal', 'warm', 'pink'];
    const n = Math.max(12, Math.min(48, Math.round(h / 46)));
    for (let i = 0; i < n; i += 1) {
      const y = ((i + 0.5) / n) * h + (rnd() - 0.5) * 40;
      out.push({
        x: (y - mid) * shear + (rnd() - 0.5) * 70,
        y,
        r: (74 + rnd() * 78) * (0.8 + rnd() * 0.5),
        a: 0.05 + rnd() * 0.055,
        k: 0.55 + rnd() * 0.2,
        tone: tones[i % tones.length],
      });
    }
    return out;
  }

  function measure() {
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    vw = Math.max(1, Math.round(rect.width));
    vh = Math.max(1, Math.round(rect.height));
    dpr = Math.min(3, Math.max(1, Number(window.devicePixelRatio) || 1));
    unit = vw / 392;
    canvas.width = Math.round(vw * dpr);
    canvas.height = Math.round(vh * dpr);
    canvas.style.width = `${vw}px`;
    canvas.style.height = `${vh}px`;
    ctx = canvas.getContext('2d');
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    padTop = Math.round(vh / 6);
    layoutHeight();
  }

  function layoutHeight() {
    const body = data ? data.height : 0;
    contentH = padTop + body * zoom + Math.round(vh * 0.35);
    spacer.style.height = `${contentH}px`;
  }

  // ── 绘制 ────────────────────────────────────────────────────────
  function screenOf(p) {
    return { x: vw / 2 + p.x * zoom, y: padTop + p.y * zoom - scrollTop };
  }

  function schedule() {
    if (destroyed || rafId) return;
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
    rafId = raf(() => {
      rafId = 0;
      draw();
    });
  }

  function draw() {
    if (!ctx || destroyed) return;
    ctx.clearRect(0, 0, vw, vh);
    const fs = Math.round(11 * unit);

    // 河心那道光带：真正让「银河横过天空」成立的，是这条很长、边缘很软的亮带，
    // 不是星星本身。它跟着带子的斜度走，滚动时整条一起滑。
    const shear = (data && Number(data.shear)) || 0;
    if (shear) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.translate(vw / 2, padTop - scrollTop);
      ctx.rotate(Math.atan(shear));
      const halfW = 165 * unit;
      const g = ctx.createLinearGradient(-halfW, 0, halfW, 0);
      g.addColorStop(0, 'rgba(255,240,244,0)');
      g.addColorStop(0.36, 'rgba(255,226,236,0.045)');
      g.addColorStop(0.5, 'rgba(255,238,242,0.085)');
      g.addColorStop(0.64, 'rgba(255,226,236,0.045)');
      g.addColorStop(1, 'rgba(255,240,244,0)');
      ctx.fillStyle = g;
      ctx.fillRect(-halfW, -4000, halfW * 2, 8000);
      ctx.restore();
    }

    // 雾团：点再多也只是点阵，雾才让带子有体积。
    if (nebulae.length) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < nebulae.length; i += 1) {
        const nb = nebulae[i];
        const y = padTop + nb.y * zoom - scrollTop * nb.k;
        if (y < -nb.r || y > vh + nb.r) continue;
        const x = vw / 2 + nb.x * zoom;
        const rad = nb.r * unit * zoom;
        ctx.globalAlpha = nb.a;
        const sp = glowSprite(colors[nb.tone] || colors.warm, 0.35);
        if (sp) ctx.drawImage(sp, x - rad, y - rad, rad * 2, rad * 2);
      }
      ctx.restore();
    }

    // 再铺星尘：它给的是「数量」。远层慢、近层快，滑动时错开 —— 这就是纵深。
    if (dust.length) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < dust.length; i += 1) {
        const d = dust[i];
        const y = padTop + d.y * zoom - scrollTop * d.k;
        if (y < -6 || y > vh + 6) continue;
        const x = vw / 2 + d.x * zoom;
        const r = Math.max(0.5, d.r * unit);
        ctx.globalAlpha = d.a;
        ctx.fillStyle = colors[d.tone] || colors.warm;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
      }
      ctx.restore();
    }

    // 中心星：顶部 1/6，樱粉。随滚动缓慢淡出，不抢戏。
    const cy = padTop - scrollTop;
    if (cy > -60 && cy < vh + 60) {
      const fade = Math.max(0.15, 1 - Math.abs(scrollTop) / (vh * 0.9));
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      // 核心给大一点：它是整条带子的「核」，太小就只剩一个点撑不起场；
      // 但别太大 —— 第一版 halo 15 直接糊成一盏灯，压到 10。
      drawStar(vw / 2, cy, 5.4 * unit, centerColor || colors.pink, 0.5 * fade, { halo: 9, glow: 0.66, core: 0.7 });
      drawStar(vw / 2, cy, 4.2 * unit, centerColor || colors.pink, 0.95 * fade, { halo: 6.6, glow: 0.58 });
      ctx.restore();
      ctx.save();
      ctx.globalAlpha = 0.42 * fade;
      ctx.strokeStyle = centerColor || colors.pink;
      ctx.lineWidth = Math.max(1, 1 * unit);
      ctx.beginPath();
      ctx.arc(vw / 2, cy, 10 * unit, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    if (!points.length) return;

    // 事件之间的联系：细虚线，吊在时间线后面。
    // 平时几乎看不见（只怕把河搅浑），点开一颗星才亮 —— 那一下就是「这两件事其实是一回事」。
    const ties = (data && data.ties) || [];
    if (ties.length) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineWidth = Math.max(1, 1.1 * unit);
      ctx.setLineDash([2.5 * unit, 5 * unit]);
      ties.forEach((tie) => {
        const pa = points[tie.a];
        const pb = points[tie.b];
        if (!pa || !pb) return;
        const touch = focus != null && (tie.a === focus || tie.b === focus);
        const dim = only && only !== pa.kind;
        ctx.globalAlpha = touch ? 0.55 : (focus != null ? 0.03 : (dim ? 0.02 : 0.16));
        ctx.strokeStyle = touch ? colors.pink : colors.warm;
        const a = { x: vw / 2 + tie.x1 * zoom, y: padTop + tie.y1 * zoom - scrollTop };
        const b = { x: vw / 2 + tie.x2 * zoom, y: padTop + tie.y2 * zoom - scrollTop };
        const c = { x: vw / 2 + tie.cx * zoom, y: padTop + tie.cy * zoom - scrollTop };
        if (Math.max(a.y, b.y) < -60 || Math.min(a.y, b.y) > vh + 60) return;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.quadraticCurveTo(c.x, c.y, b.x, b.y);
        ctx.stroke();
      });
      ctx.setLineDash([]);
      ctx.restore();
    }

    // 弧线：加法混合的辉光，黑暗里一丝一丝
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineWidth = Math.max(1, 1 * unit);
    ((data && data.links) || []).forEach((ln) => {
      const dim = only && only !== ln.kind;
      ctx.globalAlpha = dim ? 0.015 : 0.07;
      ctx.strokeStyle = colorOf(ln.kind);
      const a = { x: vw / 2 + ln.x1 * zoom, y: padTop + ln.y1 * zoom - scrollTop };
      const b = { x: vw / 2 + ln.x2 * zoom, y: padTop + ln.y2 * zoom - scrollTop };
      const c = { x: vw / 2 + ln.cx * zoom, y: padTop + ln.cy * zoom - scrollTop };
      if (Math.max(a.y, b.y) < -40 || Math.min(a.y, b.y) > vh + 40) return;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(c.x, c.y, b.x, b.y);
      ctx.stroke();
    });
    ctx.restore();

    // 摆位先算：刻度的日期要能避开星点的字，不然右下角会叠成一团
    const plans = planLabels();

    // 主题簇：老大 20:22 说「去掉吧」——图上不再画括号和主题名。
    // 计算仍在 core 里（数据留着，将来想开回来只要把下面这行改回去）。
    const clusters = [];
    clusterDrawn = 0;
    clusterSeen = clusters.length;
    clusters.forEach((c) => {
      // 放大到 1.45 倍时括号会被顶出屏幕，钳在画布里；名字跟着往回缩，不然半边字没了
      // 括号要贴着星，不能按布局坐标缩放：1.45 倍时会把括号甩到屏幕边上，跟星脱开。
      // 所以拿成员的屏幕 x 取最外那一颗，再往外让 26u。
      const memX = (c.members || []).map((i) => vw / 2 + ((data.points && data.points[i]) ? data.points[i].x : 0) * zoom);
      const edge = c.side < 0
        ? (memX.length ? Math.min(...memX) : vw / 2 + c.x * zoom) - 26 * unit
        : (memX.length ? Math.max(...memX) : vw / 2 + c.x * zoom) + 26 * unit;
      const cx = Math.max(26 * unit, Math.min(vw - 26 * unit, edge));
      const on = only == null;
      // 一个主题往往隔着半个月又说一次，所以带子按「连着的那一段」画好几截
      (c.runs || [{ y0: c.y0, y1: c.y1, count: c.count, index: 0 }]).forEach((run) => {
        const y0 = padTop + run.y0 * zoom - scrollTop;
        const y1 = padTop + run.y1 * zoom - scrollTop;
        clusterDrawn += 1;
        clusterLast = { x: Math.round(cx), y0: Math.round(y0), y1: Math.round(y1), vh, seen: clusters.length };
        if (Math.max(y0, y1) < -40 || Math.min(y0, y1) > vh + 40) return;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const inward = (c.side < 0 ? 1 : -1) * 10 * unit;
        const x0 = Math.min(cx, cx + inward);
        const bw = Math.abs(inward);
        // 一条淡带子（不是一根线）：远看是「这一段属于同一个主题」，不抢星点的戏
        ctx.globalAlpha = on ? 0.055 : 0.02;
        ctx.fillStyle = colors.pink;
        ctx.fillRect(x0, y0, bw, Math.max(1, y1 - y0));
        ctx.globalAlpha = on ? 0.3 : 0.12;
        ctx.strokeStyle = colors.pink;
        ctx.lineWidth = Math.max(1, 0.9 * unit);
        ctx.beginPath();
        ctx.moveTo(cx + inward, y0);
        ctx.lineTo(cx, y0);
        ctx.lineTo(cx, y1);
        ctx.lineTo(cx + inward, y1);
        ctx.stroke();
        ctx.globalAlpha = on ? 0.55 : 0.2;
        ctx.fillStyle = colors.pink;
        ctx.font = `500 ${10.5 * unit}px system-ui, -apple-system, "Noto Sans SC", sans-serif`;
        // 名字写在括号的内侧（靠河那边），贴边会被裁掉，也会压到底部的提示
        ctx.textAlign = c.side < 0 ? 'left' : 'right';
        ctx.textBaseline = 'middle';
        // 这一段可能还是比屏幕长：名字钉在「当前能看见的那一段」的中间
        const mid = Math.max(24 * unit, Math.min(vh - 42 * unit, (y0 + y1) / 2));
        const label = run.index === 0 ? `${c.name} · ${c.count}` : c.name;
        const near = c.side < 0 ? cx + bw + 5 * unit : cx - bw - 5 * unit;
        ctx.fillText(label, near, mid);
        ctx.restore();
      });
    });

    // 时间刻度：只作分隔
    ctx.save();
    ctx.font = `400 ${fs}px system-ui, -apple-system, "Noto Sans SC", sans-serif`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ((data && data.rulers) || []).forEach((r) => {
      const y = padTop + r.y * zoom - scrollTop;
      if (y < -20 || y > vh + 20) return;
      ctx.globalAlpha = only ? 0.06 : 0.13;
      ctx.strokeStyle = colors.faint;
      ctx.setLineDash([2 * unit, 6 * unit]);
      ctx.beginPath();
      ctx.moveTo(18 * unit, y);
      ctx.lineTo(vw - 18 * unit, y);
      ctx.stroke();
      ctx.setLineDash([]);
      const textW = ctx.measureText(r.label).width;
      const rx1 = vw - 20 * unit;
      const rx0 = rx1 - textW;
      const covered = plans.some((l) => {
        const b = labelBox(l);
        return Math.abs(b.y - y) < fs * 0.9 && b.x1 > rx0 - 4 * unit && b.x0 < rx1 + 4 * unit;
      });
      if (covered) return;
      ctx.globalAlpha = only ? 0.12 : 0.3;
      ctx.fillStyle = colors.faint;
      ctx.fillText(r.label, rx1, y);
    });
    ctx.restore();

    // 微星：一条消息一颗。事件星是「事」，这些是「话」——
    // 它们围着事件散开，画面才有密度，而且每一颗都对得上真的一句。
    ((data && data.specks) || []).forEach((s) => {
      if (only && only !== s.kind) return;
      const x = vw / 2 + s.x * zoom;
      const y = padTop + s.y * zoom - scrollTop;
      if (y < -12 || y > vh + 12) return;
      drawStar(x, y, s.r, colors.warm, s.alpha * (focus != null ? 0.4 : 1), { halo: 2.6, glow: 0.5 });
    });

    // 星点：越久远越暗越小；光晕走贴图，跟电脑版同一套衰减
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    points.forEach((p, i) => {
      const { x, y } = screenOf(p);
      if (y < -40 || y > vh + 40) return;
      const linked = focus != null && i !== focus && (p.tied || []).indexOf(focus) >= 0;
      const dim = (only && only !== p.kind) || (focus != null && i !== focus && !linked);
      const base = colorOf(p.kind, p.ref);
      const lit = focus === i;
      const r = p.r * zoom * (lit ? 1.15 : (linked ? 1.05 : 1));
      const alpha = (dim ? 0.12 : 1) * p.alpha;
      drawStar(x, y, r, base, alpha * 0.92, { halo: lit ? 6.4 : 4.6, glow: 0.6, core: dim ? 0 : 1 });
      // 有联系的星外面套一圈极淡的樱粉：线条会滑出屏幕，这圈不会，
      // 扫一眼就知道「这些事是互相挂着的」。
      if ((p.tied || []).length && !dim) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = lit ? 0.5 : (focus != null ? 0.06 : 0.16);
        ctx.strokeStyle = colors.pink;
        ctx.lineWidth = Math.max(1, 0.9 * unit);
        ctx.beginPath();
        ctx.arc(x, y, Math.max(4.5 * unit, r * 2.8), 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    });
    ctx.restore();

    // 星星旁边的字：放大到一定倍数才出来，缩回去就收干净。
    // 为什么用 canvas 画而不是 DOM：一屏几十个标签，DOM 每次缩放都要重排，会掉帧。
    if (plans.length) {
      const size = Math.round(10 * unit);
      ctx.save();
      ctx.font = `400 ${size}px system-ui, -apple-system, "Noto Sans SC", sans-serif`;
      ctx.textBaseline = 'middle';
      plans.forEach((l) => {
        ctx.textAlign = l.align;
        ctx.globalAlpha = l.alpha;
        ctx.fillStyle = colorOf(l.p.kind, l.p.ref);
        ctx.fillText(l.text, l.tx, l.yc);
      });
      ctx.restore();
    }
  }

  function labelBox(l) {
    const x0 = l.align === 'left' ? l.tx : (l.align === 'right' ? l.tx - l.w : l.tx - l.w / 2);
    return { x0, x1: x0 + l.w, y: l.yc };
  }

  // 先算摆位、不画：新的标签优先占位，老的挤不下就不出现（不硬叠在别的星上）
  function planLabels() {
    if (zoom < LABEL_ZOOM) return [];
    const fade = Math.min(1, (zoom - LABEL_ZOOM) / 0.35);
    const size = Math.round(10 * unit);
    const out = [];
    const used = [];
    const bodies = [];
    points.forEach((p) => {
      const { x, y } = screenOf(p);
      if (y < -40 || y > vh + 40) return;
      bodies.push({ p, x, y, r: Math.max(p.r * zoom * 5.8, 6 * unit) });
    });
    const prevFont = ctx.font;
    const prevAlign = ctx.textAlign;
    const prevBaseline = ctx.textBaseline;
    ctx.font = `400 ${size}px system-ui, -apple-system, "Noto Sans SC", sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    points.forEach((p) => {
      const text = String(p.label || '').trim();
      if (!text) return;
      if (only && only !== p.kind) return;
      const { x, y } = screenOf(p);
      if (y < 4 || y > vh - 4) return;
      if (used.some((uy) => Math.abs(uy - y) < size + 3)) return;
      const reach = Math.max(p.r * zoom * 5.8, 6 * unit);
      const label = text.length > 12 ? `${text.slice(0, 12)}…` : text;
      const w = ctx.measureText(label).width;
      const gap = reach * 0.82 + 4 * unit;
      let tx = x + gap;
      let align = 'left';
      if (tx + w > vw - 12 * unit) {
        tx = x - gap;
        align = 'right';
      }
      if (align === 'right' && tx - w < 12 * unit) {
        // 两边都摆不下（标签太长的中间点）：居中压在星下面，别硬贴着屏幕边
        align = 'center';
        tx = x;
      }
      const yc = align === 'center' ? y + reach * 0.62 + size * 0.9 : y;
      const bx0 = align === 'left' ? tx : (align === 'right' ? tx - w : tx - w / 2);
      const bx1 = align === 'left' ? tx + w : (align === 'right' ? tx : tx + w / 2);
      const clash = bodies.some((b) => b.p !== p
        && Math.abs(b.y - yc) < b.r * 0.85 + size * 0.8
        && b.x > bx0 - 6 * unit && b.x < bx1 + 6 * unit);
      if (clash) return;
      out.push({ p, text: label, tx, yc, align, w, alpha: (0.30 + 0.55 * fade) * p.alpha });
      used.push(y);
    });
    ctx.font = prevFont;
    ctx.textAlign = prevAlign;
    ctx.textBaseline = prevBaseline;
    return out;
  }


  // ── 交互 ────────────────────────────────────────────────────────
  function hitTest(clientX, clientY) {
    if (!points.length || !stage) return null;
    const rect = stage.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    let best = null;
    let bestD = 22 * unit;
    points.forEach((p) => {
      const { x, y } = screenOf(p);
      const d = Math.hypot(x - sx, y - sy);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    });
    return best;
  }

  /** 顺着连线跳到另一颗星：滚到它那儿，然后把它点开。 */
  function jumpTo(p) {
    if (!p || !viewport) return;
    const { y } = screenOf(p);
    const target = Math.max(0, Math.min(Math.max(0, contentH - vh), viewport.scrollTop + y - vh * 0.42));
    viewport.scrollTop = target;
    scrollTop = viewport.scrollTop;
    schedule();
    openSheet(p);
  }

  function openSheet(p) {
    if (!p || !sheet) return;
    const self = points.indexOf(p);
    focus = self >= 0 ? self : null;
    // 卡片会盖住下半屏：把点开的那颗挪到上半屏，不然它的联系线全被卡片挡住
    if (focus != null && viewport) {
      const pos = screenOf(p);
      if (pos.y > vh * 0.42 || pos.y < vh * 0.12) {
        const target = Math.max(0, Math.min(Math.max(0, contentH - vh), viewport.scrollTop + pos.y - vh * 0.3));
        viewport.scrollTop = target;
        scrollTop = viewport.scrollTop;
      }
    }
    schedule();
    while (sheet.firstChild) sheet.removeChild(sheet.firstChild);

    const kind = document.createElement('p');
    kind.className = 'el-river-sheet-kind';
    kind.textContent = `${kindLabel(p.kind)} · ${dayText(p.date)}`;

    const title = document.createElement('p');
    title.className = 'el-river-sheet-title';
    title.textContent = p.label || kindLabel(p.kind);

    sheet.append(kind, title);
    // 主题行：跟括号一起下线了（老大 20:22「去掉吧」）。
    if (p.hint && p.hint !== p.label) {
      const body = document.createElement('p');
      body.className = 'el-river-sheet-body';
      body.textContent = p.hint;
      sheet.append(body);
    }

    // 「和它连在一起的」：这才是星图跟时间轴的区别 —— 十月的加班和这周的加班是一件事。
    const related = (p.tied || []).map((idx) => points[idx]).filter(Boolean).slice(0, 3);
    if (related.length) {
      const label = document.createElement('p');
      label.className = 'el-river-sheet-rel-title';
      label.textContent = t('starmap.related', '和这几件连在一起');
      sheet.append(label);
      const list = document.createElement('div');
      list.className = 'el-river-sheet-rel';
      related.forEach((q) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'el-river-rel';
        const dot = document.createElement('i');
        dot.className = 'el-river-rel-dot';
        dot.dataset.kind = q.kind;
        const text = document.createElement('span');
        text.className = 'el-river-rel-text';
        text.textContent = q.label || kindLabel(q.kind);
        const when = document.createElement('span');
        when.className = 'el-river-rel-when';
        when.textContent = dayText(q.date);
        btn.append(dot, text, when);
        btn.addEventListener('click', () => jumpTo(q));
        list.append(btn);
      });
      sheet.append(list);
    }

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'el-river-sheet-close';
    close.textContent = t('starmap.close', '收起');
    close.addEventListener('click', closeSheet);
    sheet.append(close);

    sheet.hidden = false;
    // 下一帧再挂 is-open，让 CSS 的滑出动画有起点
    (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 16))(() => {
      if (sheet) sheet.classList.add('is-open');
    });

    if (props.onOpen) {
      try {
        props.onOpen({ day: p.date, kind: p.kind, label: p.label, ref: p.ref });
      } catch (err) {
        console.warn('[starmap] onOpen 抛错', err);
      }
    }
  }

  function closeSheet() {
    if (!sheet) return;
    sheet.classList.remove('is-open');
    sheet.hidden = true;
    focus = null;
    schedule();
  }

  let touchStart = null;
  let pinchStart = null;

  function bind() {
    viewport.addEventListener('scroll', () => {
      scrollTop = viewport.scrollTop;
      schedule();
    }, { passive: true });

    // 手势都落在滚动容器上（画布是 pointer-events:none 的装饰层）
    stage.addEventListener('pointerdown', (e) => {
      touchStart = { x: e.clientX, y: e.clientY, at: Date.now() };
    });

    stage.addEventListener('pointerup', (e) => {
      if (!touchStart) return;
      const moved = Math.hypot(e.clientX - touchStart.x, e.clientY - touchStart.y);
      const held = Date.now() - touchStart.at;
      touchStart = null;
      if (moved > 12 || held > 700) return; // 那是拖动/长按，不是「点一下」
      const now = Date.now();
      if (now - lastTapAt < 260) return; // 双指缩放的余波，别当两次点击
      lastTapAt = now;
      const hit = hitTest(e.clientX, e.clientY);
      if (hit) openSheet(hit);
      else if (sheet && !sheet.hidden) closeSheet(); // 点空白处收起，焦点也跟着散掉
    });

    // 双指缩放：保留，但不宣传（提示只写「上下滑动 · 点开看看」）
    stage.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 2) return;
      pinchStart = { d: dist(e.touches), zoom };
    }, { passive: true });

    stage.addEventListener('touchmove', (e) => {
      if (!pinchStart || e.touches.length !== 2) return;
      const next = pinchStart.zoom * (dist(e.touches) / (pinchStart.d || 1));
      zoom = Math.min(2.4, Math.max(0.7, next));
      layoutHeight();
      schedule();
    }, { passive: true });

    stage.addEventListener('touchend', () => {
      pinchStart = null;
    }, { passive: true });

    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => {
        measure();
        schedule();
      });
      ro.observe(stage);
      root.__riverRO = ro;
    }
  }

  function dist(touches) {
    const [a, b] = [touches[0], touches[1]];
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }

  // ── 数据 ────────────────────────────────────────────────────────
  /** 两种形状都吃：`{points,links,rulers,groups,height}`（river）或老的周列 `{points,bounds}`。 */
  function setData(d) {
    data = d || null;
    points = (data && Array.isArray(data.points)) ? data.points : [];
    dust = buildDust(data);
    nebulae = buildNebulae(data);
    if (data && !data.height && points.length) {
      // 老形状（周列）：没有 y 轴时间语义，临时按索引排一遍，别让页面空着
      const sorted = points.slice().sort((a, b) => (b.at || 0) - (a.at || 0));
      let y = 64;
      sorted.forEach((p, i) => {
        if (i > 0 && i % 5 === 0) y += 30;
        p.y = y;
        p.x = (p.kind === 'memory' || p.kind === 'letter' ? 1 : -1) * (46 + ((i * 37) % 18));
        p.r = 3 + (i % 3) * 0.6;
        p.alpha = 0.95 - (i / Math.max(1, sorted.length)) * 0.5;
        y += 34;
      });
      points = sorted;
      data = { ...data, links: [], rulers: [], groups: [], height: y };
    }
    emptyEl.hidden = points.length > 0;
    hintEl.hidden = points.length === 0;
    layoutHeight();
    paintChips();
    readColors();
    schedule();
    // 探针（真机上我要能一眼看出「图里有几个点 / 几条弧线」，别靠截图猜）
    if (root) {
      root.__riverDebug = () => ({
        points: points.length,
        links: ((data && data.links) || []).length,
        ties: ((data && data.ties) || []).length,
        clusters: ((data && data.clusters) || []).map((c) => ({ name: c.name, count: c.count, y0: Math.round(c.y0), y1: Math.round(c.y1), runs: (c.runs || []).map((r) => ({ y0: Math.round(r.y0), y1: Math.round(r.y1), count: r.count })) })),
        tiedPoints: points.filter((p) => (p.tied || []).length).length,
        focus,
        rulers: ((data && data.rulers) || []).length,
        groups: ((data && data.groups) || []).map((g) => `${g.kind}:${g.count}`),
        height: (data && data.height) || 0,
        scrollTop,
        only,
        zoom,
        first: points.slice(0, 3).map((p) => {
          const pos = screenOf(p);
          return { kind: p.kind, label: p.label, x: Math.round(pos.x), y: Math.round(pos.y) };
        }),
        clustered: points
          .map((p, i) => ({ p, i }))
          .filter(({ p }) => p.cluster)
          .slice(0, 6)
          .map(({ p, i }) => {
            const pos = screenOf(p);
            return { i, cluster: p.cluster, label: p.label, x: Math.round(pos.x), y: Math.round(pos.y) };
          }),
        clusterSeen,
        clusterDrawn,
        clusterLast,
        labelZoom: LABEL_ZOOM,
        labelsOn: zoom >= LABEL_ZOOM,
        // 有联系的那几颗星（屏幕坐标），探针合成点击用
        tied: points
          .map((p, i) => ({ p, i }))
          .filter(({ p }) => (p.tied || []).length)
          .slice(0, 5)
          .map(({ p, i }) => {
            const pos = screenOf(p);
            return { i, label: p.label, links: (p.tied || []).length, x: Math.round(pos.x), y: Math.round(pos.y) };
          }),
      });
      // 双指缩放在模拟器上不好合成，留一个口子直接改倍率（真机验证也用它）
      root.__riverZoom = (z) => {
        if (Number.isFinite(z)) {
          zoom = Math.min(2.4, Math.max(0.7, z));
          layoutHeight();
          schedule();
        }
        return zoom;
      };
    }
  }

  function loadCenterTint() {
    affectCore()
      .then(async (mod) => {
        if (!mod || destroyed) return null;
        const st = await mod.loadAffect({ persist: false });
        if (destroyed) return null;
        const id = mod.snapshot(st).band.id;
        const next = BAND_TINT[id] || null;
        if (next && next !== centerColor) {
          centerColor = next;
          if (root) root.setAttribute('data-band', id);
          schedule();
        }
        return null;
      })
      .catch(() => {});
  }

  function render(container, mountProps = {}) {
    root = container;
    props = mountProps || {};
    buildShell(container);
    measure();
    readColors();
    loadCenterTint();
    const injected = props.data;
    if (injected) setData(injected);
    else {
      starmapCore().then((core) => {
        if (!core || destroyed) return;
        const build = core.riverData || core.starmapData;
        if (!build) return;
        return build({ weeks: 12 })
          .then((d) => {
            if (!destroyed) setData(d);
          })
          .catch((err) => console.warn('[starmap] 建图失败', err));
      });
    }
    return {
      setData: (d) => setData(d),
      refresh: () => {
        starmapCore().then((core) => {
          const build = core && (core.riverData || core.starmapData);
          if (!build) return null;
          return build({ weeks: 12 }).then((d) => setData(d));
        }).catch(() => {});
      },
      closeSheet: () => closeSheet(),
      destroy: () => {
        destroyed = true;
        if (root && root.__riverRO) {
          try { root.__riverRO.disconnect(); } catch (err) { /* 忽略 */ }
          delete root.__riverRO;
        }
        points = [];
        data = null;
        ctx = null;
      },
    };
  }

  return {
    mount: (el, mountProps) => render(el, mountProps),
    destroy: () => {
      destroyed = true;
      if (root && root.__riverRO) {
        try { root.__riverRO.disconnect(); } catch (err) { /* 忽略 */ }
      }
    },
  };
}



