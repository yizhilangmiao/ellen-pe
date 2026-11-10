/* ============================================================================
 * ellen-sync memory-map  ·  记忆星图（手机版 · 竖排时间星河）
 * ----------------------------------------------------------------------------
 * 落点：work/assets/public/ellen-startup-opening.js 末尾（由 _patch_phone_memorymap.py 拼接）
 * 组成：渲染层＝电脑版 src/ui/memory-map.js 原文 + 手机版专属补丁（见 build-phone-inject.cjs）
 *       数据层＝读宿主 IndexedDB 的 memory 记录 → 建图 → 全屏面板
 * 入口：「回忆 → 记忆」页 tab 行右侧的「星图」按钮
 * 铁律：电脑版源文件不动；只读宿主库，不写、不建库、不升级版本；不新增 APK 条目。
 * ========================================================================== */
/* ==== ELLEN-INJECT memory-map BEGIN ==== */
(function () {
  "use strict";
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.__ellenMemoryMap) return;
  window.__ellenMemoryMap = { version: "0.3.0", at: Date.now() };

  /* ------------------- 渲染层：电脑版 src/ui/memory-map.js + 手机补丁 ------------------- */
"use strict";
// 记忆星图（电脑版同页 3D 渲染）
// ---------------------------------------------------------------------------
// 由 _临时\记忆爆炸图3d\index3d.html 移植：原样搬 WebGL 着色器与四种布局，
// 只改三件事——数据从外面传进来、尺寸跟着容器走、标签层进 panel 里。
//
// 为什么不做 iframe：index.html 的 CSP 是 `default-src 'self'`，file:// 下的
// 'self' 匹配不可靠，iframe 加载同目录 html 会被拦。所以直接同页开 canvas。
//
// 为什么不用 three.js：这里只画「点 + 线」，自己写 600 行比引一个库更稳，
// 而且电脑版是 --disable-gpu 跑 SwiftShader，少一层依赖少一个黑屏理由。
//
// 接口：
//   window.EllenMemoryMap.mount(container, payload, { rootLabel })
//   window.EllenMemoryMap.unmount()
//   window.EllenMemoryMap.setLayout(name)   // shell | orbit | nebula | helix
// payload 就是后端 memory-review 的 { type:"graph" } 返回体：{ tree, nodes, edges, stats }
// ---------------------------------------------------------------------------
(() => {
  const HUES = ["#e8b3c6", "#dfa4bb", "#d396ac", "#eebccd", "#cb87a2", "#e3a9bf", "#d99bb2", "#ecc0d2"];
  const LABEL_POOL_MAX = 32;
  const LAYOUT_NAMES = ["shell", "orbit", "nebula", "helix"];
  const LAYOUT_LABELS = { shell: "球壳", orbit: "轨道", nebula: "星云", helix: "双螺旋" };
  const VIEW_OF = {
    shell: { yaw: 0.70, pitch: 0.36 },
    orbit: { yaw: 0.58, pitch: 0.52 },
    nebula: { yaw: 0.72, pitch: 0.30 },
    helix: { yaw: 0.46, pitch: 0.12 },
    portrait: { yaw: 0.16, pitch: 0.03 },
    landscape: { yaw: 0.10, pitch: 0.02 },
  };
  const R1 = 176;
  const R2 = 306;

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeOutExpo = (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
  // 确定性伪随机：同一份记忆每次打开都长在同一个位置，否则每次看都像换了一张图
  const rnd = (seed) => {
    const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  };
  const hex2rgb = (h) => [
    parseInt(h.slice(1, 3), 16) / 255,
    parseInt(h.slice(3, 5), 16) / 255,
    parseInt(h.slice(5, 7), 16) / 255,
  ];

  // ── 矩阵 ────────────────────────────────────────────────
  const mat4 = () => new Float32Array(16);

  function perspective(out, fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2);
    out.fill(0);
    out[0] = f / aspect;
    out[5] = f;
    out[10] = (far + near) / (near - far);
    out[11] = -1;
    out[14] = (2 * far * near) / (near - far);
    return out;
  }

  function lookAt(out, ex, ey, ez, cx, cy, cz, ux, uy, uz) {
    let zx = ex - cx, zy = ey - cy, zz = ez - cz;
    let len = Math.hypot(zx, zy, zz) || 1;
    zx /= len; zy /= len; zz /= len;
    let xx = uy * zz - uz * zy, xy = uz * zx - ux * zz, xz = ux * zy - uy * zx;
    len = Math.hypot(xx, xy, xz) || 1;
    xx /= len; xy /= len; xz /= len;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
    out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
    out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
    out[12] = -(xx * ex + xy * ey + xz * ez);
    out[13] = -(yx * ex + yy * ey + yz * ez);
    out[14] = -(zx * ex + zy * ey + zz * ez);
    out[15] = 1;
    return out;
  }

  function mulMat(out, a, b) {
    for (let i = 0; i < 4; i++) {
      const a0 = a[i], a1 = a[i + 4], a2 = a[i + 8], a3 = a[i + 12];
      out[i] = a0 * b[0] + a1 * b[1] + a2 * b[2] + a3 * b[3];
      out[i + 4] = a0 * b[4] + a1 * b[5] + a2 * b[6] + a3 * b[7];
      out[i + 8] = a0 * b[8] + a1 * b[9] + a2 * b[10] + a3 * b[11];
      out[i + 12] = a0 * b[12] + a1 * b[13] + a2 * b[14] + a3 * b[15];
    }
    return out;
  }

  // ── 着色器 ──────────────────────────────────────────────
  function shaderSrc(is2) {
    const head = is2 ? "#version 300 es\n" : "";
    const attr = is2 ? "in" : "attribute";
    const varyOut = is2 ? "out" : "varying";
    const varyIn = is2 ? "in" : "varying";
    const fragOut = is2 ? "out vec4 fragColor;" : "";
    const fragName = is2 ? "fragColor" : "gl_FragColor";

    const pointVS = head +
      attr + " vec3 a_pos;\n" +
      attr + " vec3 a_col;\n" +
      attr + " float a_size;\n" +
      attr + " float a_alpha;\n" +
      "uniform mat4 u_mvp;\n" +
      "uniform float u_projScale;\n" +
      "uniform float u_glow;\n" +
      "uniform float u_fogNear;\n" +
      "uniform float u_fogFar;\n" +
      varyOut + " vec3 v_col;\n" +
      varyOut + " float v_alpha;\n" +
      "void main(){\n" +
      "  vec4 clip = u_mvp * vec4(a_pos, 1.0);\n" +
      "  gl_Position = clip;\n" +
      "  float w = max(1.0, clip.w);\n" +
      "  float grow = mix(1.0, 2.1, u_glow);\n" +
      "  gl_PointSize = clamp(a_size * grow * u_projScale / w, 1.0, 220.0);\n" +
      "  float fog = 1.0 - smoothstep(u_fogNear, u_fogFar, w);\n" +
      "  v_alpha = a_alpha * mix(0.46, 1.0, fog) * mix(1.0, 0.46, u_glow);\n" +
      "  v_col = a_col;\n" +
      "}\n";

    const pointFS = head +
      "precision highp float;\n" +
      varyIn + " vec3 v_col;\n" +
      varyIn + " float v_alpha;\n" +
      "uniform float u_glow;\n" +
      fragOut + "\n" +
      "void main(){\n" +
      "  vec2 d = gl_PointCoord - vec2(0.5);\n" +
      "  float r = length(d) * 2.0;\n" +
      "  float core = smoothstep(1.0, 0.10, r);\n" +
      "  float halo = smoothstep(1.0, 0.0, r);\n" +
      "  float a = mix(core, halo * halo, u_glow);\n" +
      "  if (a <= 0.002) discard;\n" +
      "  " + fragName + " = vec4(v_col * mix(1.0, 1.35, u_glow), a * v_alpha);\n" +
      "}\n";

    const lineVS = head +
      attr + " vec3 a_pos;\n" +
      attr + " vec3 a_col;\n" +
      attr + " float a_alpha;\n" +
      "uniform mat4 u_mvp;\n" +
      "uniform float u_fogNear;\n" +
      "uniform float u_fogFar;\n" +
      varyOut + " vec3 v_col;\n" +
      varyOut + " float v_alpha;\n" +
      "void main(){\n" +
      "  vec4 clip = u_mvp * vec4(a_pos, 1.0);\n" +
      "  gl_Position = clip;\n" +
      "  float fog = 1.0 - smoothstep(u_fogNear, u_fogFar, max(1.0, clip.w));\n" +
      "  v_alpha = a_alpha * mix(0.20, 1.0, fog);\n" +
      "  v_col = a_col;\n" +
      "}\n";

    const lineFS = head +
      "precision highp float;\n" +
      varyIn + " vec3 v_col;\n" +
      varyIn + " float v_alpha;\n" +
      fragOut + "\n" +
      "void main(){\n" +
      "  " + fragName + " = vec4(v_col, v_alpha);\n" +
      "}\n";

    return { pointVS, pointFS, lineVS, lineFS };
  }

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error("shader: " + gl.getShaderInfoLog(s));
    }
    return s;
  }

  function program(gl, vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("link: " + gl.getProgramInfoLog(p));
    return p;
  }

  // ── 数据 → 画布结构 ──────────────────────────────────────
  function buildSceneData(graph) {
    const listed = Array.isArray(graph && graph.nodes) ? graph.nodes : [];
    const nodes = [];
    const links = [];

    listed.forEach((raw, i) => {
      if (!raw) return;
      const tier = clamp(Number(raw.tier) || 0, 0, 2);
      const parent = Number.isFinite(Number(raw.parent)) ? Number(raw.parent) : -1;
      const groupIndex = Number.isFinite(Number(raw.groupIndex)) ? Number(raw.groupIndex) : -1;
      nodes.push({
        id: nodes.length,
        key: String(raw.id || "n" + i),
        label: String(raw.label || ""),
        w: clamp(Number(raw.w) || 1, 0.4, 3),
        tier,
        parent: i === 0 ? -1 : parent,
        groupIndex,
        kind: String(raw.kind || ""),
        summary: typeof raw.summary === "string" ? raw.summary : "",
        anchorAt: String(raw.anchorAt || ""),
        count: Number.isFinite(Number(raw.count)) ? Number(raw.count) : 0,
        color: groupIndex >= 0 ? hex2rgb(HUES[groupIndex % HUES.length]) : [0.92, 0.95, 1.0],
        x: 0, y: 0, z: 0,
        tx: 0, ty: 0, tz: 0,
        alpha: 1,
      });
    });

    // 根节点必须是 0 号，布局代码按 nodes[0] 当中心
    if (!nodes.length) return { nodes, links, extras: [] };

    // 同名记忆（「楼下的猫 · 冬天那阵」这种会有好几条）标签撞在一起就分不清谁是谁，
    // 给重复的那些补上日期尾巴。只改显示用的 label，不动 key。
    const seenLabel = new Map();
    for (const n of nodes) {
      if (n.tier !== 2 || !n.label) continue;
      const dup = (seenLabel.get(n.label) || 0) + 1;
      seenLabel.set(n.label, dup);
      if (dup > 1) {
        const d = (n.anchorAt || "").slice(5, 10).replace("-", "/");
        n.label = d ? n.label + " · " + d : n.label + " ·" + dup;
      }
    }

    for (const n of nodes) {
      if (n.parent >= 0 && n.parent < nodes.length && n.parent !== n.id) links.push([n.parent, n.id]);
    }

    const tagOfKey = new Map();
    nodes.forEach((n) => tagOfKey.set(n.key, n.id));

    // 联想线：跨分支的记忆之间那根「其实相关」的线。父子线已经画了，这里要去重。
    const extras = [];
    const rawEdges = Array.isArray(graph && graph.edges) ? graph.edges : [];
    for (const e of rawEdges) {
      if (!e) continue;
      let a = Number.isFinite(Number(e.a)) ? Number(e.a) : tagOfKey.get(String(e.aId || ""));
      let b = Number.isFinite(Number(e.b)) ? Number(e.b) : tagOfKey.get(String(e.bId || ""));
      if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) continue;
      if (!nodes[a] || !nodes[b]) continue;
      if (nodes[a].parent === b || nodes[b].parent === a) continue; // 树线已画
      extras.push({ a, b, weight: clamp(Number(e.weight) || 0.5, 0, 1), kind: String(e.kind || "") });
    }

    return { nodes, links, extras };
  }

  // ── 一个可运行的星图场景 ─────────────────────────────────
  function createScene(container, graph, opts) {
    const options = opts || {};
    const canvas = document.createElement("canvas");
    canvas.className = "memory-map-canvas";
    const labelLayer = document.createElement("div");
    labelLayer.className = "memory-map-labels";
    container.append(canvas, labelLayer);

    const glOpts = { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: "high-performance" };
    let gl = canvas.getContext("webgl2", glOpts);
    let isGL2 = !!gl;
    if (!gl) gl = canvas.getContext("webgl", glOpts) || canvas.getContext("experimental-webgl", glOpts);
    if (!gl) {
      const tip = document.createElement("p");
      tip.className = "memory-map-fallback";
      tip.textContent = "这台设备的图形驱动没能打开 WebGL，星图暂时画不出来。记忆本身没受影响。";
      container.append(tip);
      canvas.remove();
      return { destroy() { tip.remove(); }, setLayout() {}, relayout() {}, reset() {}, ok: false };
    }

    const SRC = shaderSrc(isGL2);
    const progPoint = program(gl, SRC.pointVS, SRC.pointFS);
    const progLine = program(gl, SRC.lineVS, SRC.lineFS);
    const uni = (prog, name) => gl.getUniformLocation(prog, name);
    const PU = {
      mvp: uni(progPoint, "u_mvp"),
      projScale: uni(progPoint, "u_projScale"),
      glow: uni(progPoint, "u_glow"),
      fogNear: uni(progPoint, "u_fogNear"),
      fogFar: uni(progPoint, "u_fogFar"),
    };
    const LU = { mvp: uni(progLine, "u_mvp"), fogNear: uni(progLine, "u_fogNear"), fogFar: uni(progLine, "u_fogFar") };
    const aPoint = {
      pos: gl.getAttribLocation(progPoint, "a_pos"),
      col: gl.getAttribLocation(progPoint, "a_col"),
      size: gl.getAttribLocation(progPoint, "a_size"),
      alpha: gl.getAttribLocation(progPoint, "a_alpha"),
    };
    const aLine = {
      pos: gl.getAttribLocation(progLine, "a_pos"),
      col: gl.getAttribLocation(progLine, "a_col"),
      alpha: gl.getAttribLocation(progLine, "a_alpha"),
    };

    // 性能档：电脑版默认 --disable-gpu，实测走 SwiftShader，所以 soft 档是常态
    let tierName = "mid";
    try {
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      const renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : "";
      if (/SwiftShader|Software|llvmpipe|Basic Render/i.test(renderer)) tierName = "soft";
      else if (/Intel|UHD|Iris|Mali|Adreno|PowerVR|Apple GPU/i.test(renderer)) tierName = "mid";
      else if (renderer) tierName = "high";
    } catch { tierName = "soft"; }
    const PERF = {
      soft: { dpr: 1.0, labelMax: 12 },
      mid: { dpr: 1.4, labelMax: 16 },
      high: { dpr: 1.8, labelMax: 18 },
    }[tierName] || { dpr: 1.2, labelMax: 14 };
    let glowOn = true;
    const labelMax = (options && options.labelMax > 0 ? options.labelMax : PERF.labelMax);

    // 数据
    const data = buildSceneData(graph);
    const nodes = data.nodes;
    const links = data.links;
    const extras = data.extras;
    const N = nodes.length;
    const LINE_SEG = links.length;
    const EXTRA_SEG = extras.length;

    // 顶点缓冲
    const ptPos = new Float32Array(N * 3);
    const ptCol = new Float32Array(N * 3);
    const ptSize = new Float32Array(N);
    const ptAlpha = new Float32Array(N);
    const lnPos = new Float32Array(Math.max(1, LINE_SEG + EXTRA_SEG) * 6);
    const lnCol = new Float32Array(Math.max(1, LINE_SEG + EXTRA_SEG) * 6);
    const lnAlpha = new Float32Array(Math.max(1, LINE_SEG + EXTRA_SEG) * 2);

    const makeBuffer = (arr) => {
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, arr, gl.DYNAMIC_DRAW);
      return b;
    };

    for (let i = 0; i < N; i++) {
      const n = nodes[i];
      ptCol[i * 3] = n.color[0] * 0.86;
      ptCol[i * 3 + 1] = n.color[1] * 0.86;
      ptCol[i * 3 + 2] = n.color[2] * 0.86;
      ptSize[i] = (n.tier === 0 ? 17 : n.tier === 1 ? 3.0 : 8) * Math.min(2.6, (typeof devicePixelRatio === "number" ? devicePixelRatio : 1)) * (0.70 + clamp(n.w, 0.5, 1.8) * 0.34);
    }

    const writeLineColors = (s, a, b) => {
      lnCol[s * 6] = nodes[a].color[0]; lnCol[s * 6 + 1] = nodes[a].color[1]; lnCol[s * 6 + 2] = nodes[a].color[2];
      lnCol[s * 6 + 3] = nodes[b].color[0]; lnCol[s * 6 + 4] = nodes[b].color[1]; lnCol[s * 6 + 5] = nodes[b].color[2];
    };
    for (let s = 0; s < LINE_SEG; s++) writeLineColors(s, links[s][0], links[s][1]);
    for (let s = 0; s < EXTRA_SEG; s++) writeLineColors(LINE_SEG + s, extras[s].a, extras[s].b);

    const bPtPos = makeBuffer(ptPos);
    const bPtCol = makeBuffer(ptCol);
    const bPtSize = makeBuffer(ptSize);
    const bPtAlpha = makeBuffer(ptAlpha);
    const bLnPos = makeBuffer(lnPos);
    const bLnCol = makeBuffer(lnCol);
    const bLnAlpha = makeBuffer(lnAlpha);

    // 装饰线（轨道环）
    const DECOR_MAX = 8 * 96 * 2;
    const dcPos = new Float32Array(DECOR_MAX * 3);
    const dcCol = new Float32Array(DECOR_MAX * 3);
    const dcAlpha = new Float32Array(DECOR_MAX);
    let decorCount = 0;
    const bDcPos = makeBuffer(dcPos);
    const bDcCol = makeBuffer(dcCol);
    const bDcAlpha = makeBuffer(dcAlpha);

    // ── 视口 ──
    let W = 1, H = 1, DPR = 1, fov = 48 * Math.PI / 180;
    let started = false;

    function resize() {
      const w = container.clientWidth, h = container.clientHeight;
      if (w < 2 || h < 2) return false;
      W = w; H = h;
      DPR = Math.min(window.devicePixelRatio || 1, PERF.dpr);
      canvas.width = Math.max(1, Math.round(W * DPR));
      canvas.height = Math.max(1, Math.round(H * DPR));
      gl.viewport(0, 0, canvas.width, canvas.height);
      const portrait = H > W * 1.15;
      fov = (portrait ? 55 : W > 1400 ? 45 : 48) * Math.PI / 180;
      if (started) fitCamera();
      return true;
    }

    // ── 相机 ──
    const cam = {
      yaw: 0.7, pitch: 0.42, dist: 900, distGoal: 900,
      panX: 0, panY: 0, panXGoal: 0, panYGoal: 0,
      yawVel: 0, pitchVel: 0,
    };
    const viewMat = mat4();
    const projMat = mat4();
    const mvpMat = mat4();

    const eyePos = () => {
      const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
      return [cam.dist * cp * Math.sin(cam.yaw), cam.dist * sp, cam.dist * cp * Math.cos(cam.yaw)];
    };

    function computeView() {
      const e = eyePos();
      perspective(projMat, fov, W / Math.max(1, H), 1, 8000);
      lookAt(viewMat, e[0] + cam.panX, e[1] + cam.panY, e[2], cam.panX, cam.panY, 0, 0, 1, 0);
    }

    function project(x, y, z) {
      const m = viewMat;
      const vx = m[0] * x + m[4] * y + m[8] * z + m[12];
      const vy = m[1] * x + m[5] * y + m[9] * z + m[13];
      const vz = m[2] * x + m[6] * y + m[10] * z + m[14];
      const w = -vz;
      if (w <= 1) return null;
      const tanHalf = Math.tan(fov / 2);
      const aspect = W / Math.max(1, H);
      const ndcX = vx / (w * tanHalf * aspect);
      const ndcY = vy / (w * tanHalf);
      return {
        sx: (ndcX * 0.5 + 0.5) * W,
        sy: (1 - (ndcY * 0.5 + 0.5)) * H,
        w,
        scale: (H * 0.5) / (w * tanHalf),
      };
    }

    function fitCamera() {
      let maxR = 0;
      for (const n of nodes) {
        const d = Math.hypot(n.tx, n.ty, n.tz);
        if (d > maxR) maxR = d;
      }
      const R = Math.max(150, maxR) * 1.2;
      const tanHalf = Math.tan(fov / 2);
      const aspect = W / Math.max(1, H);
      const vFit = R / tanHalf;
      const hFit = R / (tanHalf * Math.max(0.55, aspect));
      cam.distGoal = Math.max(vFit, hFit);
      if (cam.dist < 1) cam.dist = cam.distGoal;
    }

    // 按屏幕上真实包围盒把图推到正中、撑到 84%，否则球壳边缘会被面板切掉
    function recenter() {
      cam.dist = cam.distGoal; // 先对齐，否则 span 用旧 dist 投影、目标用新 distGoal，比例会失真
      for (let iter = 0; iter < 3; iter++) {
        computeView();
        let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9, any = false;
        for (const n of nodes) {
          const pr = project(n.tx, n.ty, n.tz);
          if (!pr) continue;
          any = true;
          if (pr.sx < minX) minX = pr.sx;
          if (pr.sx > maxX) maxX = pr.sx;
          if (pr.sy < minY) minY = pr.sy;
          if (pr.sy > maxY) maxY = pr.sy;
        }
        if (!any) return;
        const spanX = Math.max(20, maxX - minX);
        const spanY = Math.max(20, maxY - minY);
        const margin = H > W ? 0.9 : 0.82;
        const k = clamp(Math.min((W * margin) / spanX, (H * margin) / spanY), 0.55, 1.75);
        lastRC = { it: iter, spanX: Math.round(spanX), spanY: Math.round(spanY), k: Number(k.toFixed(2)), margin };
        cam.distGoal = clamp(cam.distGoal / k, 220, 4200);
        cam.dist = cam.distGoal;

        const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
        const wpp = (cam.dist * Math.tan(fov / 2) * 2) / Math.max(1, H);
        const rx = viewMat[0], ry = viewMat[4], rz = viewMat[8];
        const ux = viewMat[1], uy = viewMat[5], uz = viewMat[9];
        const dxp = (W / 2 - cx) * wpp, dyp = (H / 2 - cy) * wpp;
        cam.panXGoal -= rx * dxp - ux * dyp;
        cam.panYGoal -= ry * dxp - uy * dyp;
        cam.panX = cam.panXGoal;
        cam.panY = cam.panYGoal;
        if (Math.abs(W / 2 - cx) < 2 && Math.abs(H / 2 - cy) < 2 && Math.abs(k - 1) < 0.04) break;
      }
      computeView();
    }

    // ── 布局 ──
    function layoutShell() {
      decorCount = 0;
      const branches = nodes.filter((n) => n.tier === 1);
      if (!branches.length) return;
      nodes[0].tx = 0; nodes[0].ty = 0; nodes[0].tz = 0;
      branches.forEach((b, bi) => {
        // 斐波那契球面：等纬环在 5 组时会两极堆两个、赤道挤三个，
        // 均匀球面分布看起来才是一团星，而不是一串糖葫芦
        const yy = 1 - (2 * (bi + 0.5)) / branches.length;
        const rr = Math.sqrt(Math.max(0, 1 - yy * yy));
        const ang = bi * 2.39996323 + 0.18;
        const dir = [rr * Math.cos(ang), yy, rr * Math.sin(ang)];
        b.tx = dir[0] * R1; b.ty = dir[1] * R1; b.tz = dir[2] * R1;

        const upRef = Math.abs(dir[1]) > 0.92 ? [1, 0, 0] : [0, 1, 0];
        let uxr = upRef[1] * dir[2] - upRef[2] * dir[1];
        let uyr = upRef[2] * dir[0] - upRef[0] * dir[2];
        let uzr = upRef[0] * dir[1] - upRef[1] * dir[0];
        const ul = Math.hypot(uxr, uyr, uzr) || 1;
        uxr /= ul; uyr /= ul; uzr /= ul;
        const vx = dir[1] * uzr - dir[2] * uyr;
        const vy = dir[2] * uxr - dir[0] * uzr;
        const vz = dir[0] * uyr - dir[1] * uxr;

        const kids = b.kids || [];
        const spreadBase = kids.length <= 3 ? 0.24 : kids.length <= 4 ? 0.28 : 0.33;
        kids.forEach((kid, ki) => {
          const kn = nodes[kid];
          const a = kids.length === 1 ? 0 : (ki / (kids.length - 1) - 0.5) * Math.PI * 1.55;
          const spread = spreadBase * (0.72 + rnd(kid * 3.7) * 0.62);
          const cu = Math.cos(a) * 0.88 + (rnd(kid * 5.1) - 0.5) * 0.34;
          const cv = Math.sin(a) * 0.88 + (rnd(kid * 7.3) - 0.5) * 0.34;
          const nx = dir[0] * Math.cos(spread) + (uxr * cu + vx * cv) * Math.sin(spread);
          const ny = dir[1] * Math.cos(spread) + (uyr * cu + vy * cv) * Math.sin(spread);
          const nz = dir[2] * Math.cos(spread) + (uzr * cu + vz * cv) * Math.sin(spread);
          const nl = Math.hypot(nx, ny, nz) || 1;
          kn.tx = (nx / nl) * R2; kn.ty = (ny / nl) * R2; kn.tz = (nz / nl) * R2;
        });
      });
    }

    const orbitRing = (bi) => {
      const R = R1 * 0.84 + bi * 26;
      const tiltX = 0.20 + bi * 0.32;
      const tiltY = bi * 0.66;
      const cx = Math.cos(tiltX), sx = Math.sin(tiltX);
      const cy = Math.cos(tiltY), sy = Math.sin(tiltY);
      return (phase) => {
        const x = Math.cos(phase) * R, y = Math.sin(phase) * R, z = 0;
        const y2 = y * cx - z * sx, z2 = y * sx + z * cx;
        const x2 = x * cy + z2 * sy, z3 = -x * sy + z2 * cy;
        return [x2, y2, z3];
      };
    };

    function layoutOrbit() {
      nodes[0].tx = 0; nodes[0].ty = 0; nodes[0].tz = 0;
      const branches = nodes.filter((n) => n.tier === 1);
      branches.forEach((b, bi) => {
        const ringPoint = orbitRing(bi);
        const pHome = bi * 0.86;
        const p0 = ringPoint(pHome);
        b.tx = p0[0]; b.ty = p0[1]; b.tz = p0[2];
        const kids = b.kids || [];
        kids.forEach((kid, ki) => {
          const phase = pHome + (ki - (kids.length - 1) / 2) * 0.46;
          const p = ringPoint(phase);
          const bulge = 1 + 0.13 * (ki % 2 === 0 ? 1 : -1);
          nodes[kid].tx = p[0] * bulge;
          nodes[kid].ty = p[1] * bulge;
          nodes[kid].tz = p[2] * bulge;
        });
      });
      buildOrbitRings(branches.length);
    }

    function buildOrbitRings(count) {
      const SEG = 96;
      let v = 0;
      for (let bi = 0; bi < count; bi++) {
        const ringPoint = orbitRing(bi);
        const col = hex2rgb(HUES[bi % HUES.length]);
        let prev = ringPoint(0);
        for (let i = 1; i <= SEG; i++) {
          const cur = ringPoint((i / SEG) * Math.PI * 2);
          if (v + 2 > DECOR_MAX) break;
          for (const p of [prev, cur]) {
            dcPos[v * 3] = p[0]; dcPos[v * 3 + 1] = p[1]; dcPos[v * 3 + 2] = p[2];
            dcCol[v * 3] = col[0]; dcCol[v * 3 + 1] = col[1]; dcCol[v * 3 + 2] = col[2];
            dcAlpha[v] = 0.15;
            v++;
          }
          prev = cur;
        }
      }
      decorCount = v;
      gl.bindBuffer(gl.ARRAY_BUFFER, bDcPos); gl.bufferSubData(gl.ARRAY_BUFFER, 0, dcPos);
      gl.bindBuffer(gl.ARRAY_BUFFER, bDcCol); gl.bufferSubData(gl.ARRAY_BUFFER, 0, dcCol);
      gl.bindBuffer(gl.ARRAY_BUFFER, bDcAlpha); gl.bufferSubData(gl.ARRAY_BUFFER, 0, dcAlpha);
    }

    function layoutNebula() {
      decorCount = 0;
      nodes[0].tx = 0; nodes[0].ty = 0; nodes[0].tz = 0;
      const branches = nodes.filter((n) => n.tier === 1);
      branches.forEach((b, bi) => {
        const t = (bi + 0.5) / branches.length;
        const phi = Math.acos(1 - 2 * t);
        const theta = Math.PI * (1 + Math.sqrt(5)) * (bi + 0.5);
        const cx = Math.sin(phi) * Math.cos(theta);
        const cy = Math.cos(phi);
        const cz = Math.sin(phi) * Math.sin(theta);
        const CR = R1 * 1.02;
        b.tx = cx * CR; b.ty = cy * CR; b.tz = cz * CR;

        let ux, uy, uz;
        if (Math.abs(cy) < 0.9) { ux = 0; uy = 0; uz = 1; } else { ux = 1; uy = 0; uz = 0; }
        let t1x = cy * uz - cz * uy, t1y = cz * ux - cx * uz, t1z = cx * uy - cy * ux;
        const l1 = Math.hypot(t1x, t1y, t1z) || 1;
        t1x /= l1; t1y /= l1; t1z /= l1;
        const v1x = cy * t1z - cz * t1y, v1y = cz * t1x - cx * t1z, v1z = cx * t1y - cy * t1x;

        const kids = b.kids || [];
        kids.forEach((kid, ki) => {
          const ang = ki * 2.39996 + rnd(kid * 1.3) * 0.7;
          const rad = (0.48 + rnd(kid * 3.3) * 0.30) * CR * 0.54;
          nodes[kid].tx = cx * CR + (t1x * Math.cos(ang) + v1x * Math.sin(ang)) * rad;
          nodes[kid].ty = cy * CR + (t1y * Math.cos(ang) + v1y * Math.sin(ang)) * rad;
          nodes[kid].tz = cz * CR + (t1z * Math.cos(ang) + v1z * Math.sin(ang)) * rad;
        });
      });
    }

    function layoutHelix() {
      decorCount = 0;
      nodes[0].tx = 0; nodes[0].ty = 0; nodes[0].tz = 0;
      const list = nodes.filter((n) => n.tier > 0);
      const total = list.length || 1;
      const turns = 3.4;
      const yTop = 212, yBot = -212;
      list.forEach((n, i) => {
        const t = (i + 0.5) / total;
        const strand = i % 2 === 0 ? 0 : Math.PI;
        const ang = t * Math.PI * 2 * turns + strand;
        const radius = lerp(66, 252, t);
        n.tx = Math.cos(ang) * radius;
        n.ty = lerp(yTop, yBot, t);
        n.tz = Math.sin(ang) * radius;
      });
    }

    // ── 竖排时间星河（手机专用）──
    // 电脑是「在空间里发现结构」：转、缩放、比视角，才看得出她的事怎么成团。
    // 手机竖屏窄、单手、碎片时间，这些问题全废——它要回答的是「这两个月她攒下了什么」。
    // 所以这里不铺球形：中心在顶上，记忆按时间从上往下排成一条微微摆动的河，
    // 越往下越早；同组的点由组节点从岸边牵过去。
    function layoutRiver() {
      decorCount = 0;
      const groups = nodes.filter((n) => n.tier === 1);
      const leaves = nodes.filter((n) => n.tier === 2);
      if (!groups.length) return;
      nodes[0].tx = 0;
      nodes[0].ty = R1 * 0.86;
      nodes[0].tz = 0;
      const sorted = leaves.slice().sort((a, b) => {
        const ta = String(a.anchorAt || "");
        const tb = String(b.anchorAt || "");
        if (ta && tb && ta !== tb) return tb < ta ? -1 : 1; // 新的在上，往下越翻越早
        return a.id - b.id;
      });
      const gap = Math.min(R1 * 0.26, (R1 * 1.8) / Math.max(1, sorted.length));
      const topY = R1 * 0.28;
      // 相位从 -1.6 起：i=0 时 sin 已经贴着 -1，先落左岸；
      // 14 点走完约 1.2 个周期，左右各占一半。
      // 起始相位给 0 会让前七点全在右半屏（sin 正半周），河就整条歪到右边去了。
      // 记忆点只占右半边：左半边留给组名当目录列，两者才不会混成一片。
      sorted.forEach((n, i) => {
        const ph = i * 1.15 - 1.6;
        n.tx = R1 * 0.56 + Math.sin(ph) * R1 * 0.50;
        n.ty = topY - i * gap;
        n.tz = 0;
      });
      // 组名站左岸固定一列，高度对齐自己那几条：
      // 组和记忆挤在同一条河里，读起来像「组名是记忆的标题」，层级反而丢了。
      groups.forEach((g, gi) => {
        const kids = (g.kids || []).map((k) => nodes[k]).filter(Boolean);
        let cy = topY;
        if (kids.length) {
          let s = 0;
          for (const k of kids) s += k.ty;
          cy = s / kids.length;
        }
        g.tx = -R1 * 0.74;
        g.ty = cy;
        g.tz = 0;
      });
    }

    // ── 横屏时间河（横着读）──
    // 横屏是 1098×594 这种宽屏，竖河塞进去只剩中间一条窄带；
    // 时间本来就该顺着屏幕的长边走：中心在左端，记忆从左往右铺，越靠右越早。
    function layoutRiverLand() {
      decorCount = 0;
      const groups = nodes.filter((n) => n.tier === 1);
      const leaves = nodes.filter((n) => n.tier === 2);
      if (!groups.length) return;
      nodes[0].tx = -R1 * 1.02;
      nodes[0].ty = 0;
      nodes[0].tz = 0;
      const sorted = leaves.slice().sort((a, b) => {
        const ta = String(a.anchorAt || "");
        const tb = String(b.anchorAt || "");
        if (ta && tb && ta !== tb) return tb < ta ? -1 : 1; // 新的在左，往右越翻越早
        return a.id - b.id;
      });
      const gap = R1 * 0.32;
      const leftX = -R1 * 0.52;
      // 横屏是 1.85:1 的宽屏，而二十几件事横着排开有六七倍 R1 那么长：
      // 振幅按竖屏那点幅度给，整条河就被压成屏幕正中一根细带（fillY 只有 0.27），
      // 上下全空。这里把摆幅放到 ±1.25R1，让浪头真的打到上下沿。
      sorted.forEach((n, i) => {
        const ph = i * 0.55 - 1.6;
        n.tx = leftX + i * gap;
        n.ty = Math.sin(ph) * R1 * 1.25;
        n.tz = 0;
      });
      groups.forEach((g, gi) => {
        const kids = (g.kids || []).map((k) => nodes[k]).filter(Boolean);
        let cx = leftX;
        if (kids.length) {
          let sx = 0;
          for (const k of kids) sx += k.tx;
          cx = sx / kids.length;
        }
        let cy = 0;
        if (kids.length) { let sy = 0; for (const k of kids) sy += k.ty; cy = sy / kids.length; }
        // 组名一律压到两条水平外沿上，不跟着自己那簇的平均高度走：
        // 跟着走就会浮在数据带里，「这一簇归这个名字」的判断又没了。
        g.tx = cx;
        g.ty = (gi % 2 === 0 ? 1 : -1) * R1 * 1.95;
        g.tz = 0;
      });
    }

    const LAYOUTS = { shell: layoutShell, orbit: layoutOrbit, nebula: layoutNebula, helix: layoutHelix, portrait: layoutRiver, landscape: layoutRiverLand };

    // 建 kids 关系（布局要用，后建也可以）
    const buildKids = () => {
      for (const n of nodes) n.kids = [];
      for (const n of nodes) {
        if (n.parent >= 0 && nodes[n.parent]) nodes[n.parent].kids.push(n.id);
      }
    };
    buildKids();

    // ── 焦点 ──
    let focusId = -1;
    const activeSet = new Set();
    function recomputeActive() {
      activeSet.clear();
      if (focusId < 0) return;
      let p = focusId;
      while (p >= 0) { activeSet.add(p); p = nodes[p].parent; }
      const kids = nodes[focusId].kids || [];
      for (const k of kids) activeSet.add(k);
      activeSet.add(focusId);
    }
    function setFocus(id) {
      focusId = id;
      recomputeActive();
      if (typeof options.onFocus === "function") {
        try { options.onFocus(id >= 0 ? nodes[id] : null); } catch { /* 回调出错不能拖垮渲染 */ }
      }
    }

    // ── 标签层 ──
    const pool = [];
    for (let i = 0; i < LABEL_POOL_MAX; i++) {
      const d = document.createElement("div");
      d.className = "memory-map-label";
      labelLayer.appendChild(d);
      pool.push(d);
    }

    function updateLabels() {
      const order = [];
      for (const n of nodes) {
        const pr = project(n.x, n.y, n.z);
        if (!pr) { n._pr = null; continue; }
        n._pr = pr;
        order.push({ n, pr });
      }
      order.sort((a, b) => {
        const af = focusId >= 0 && activeSet.has(a.n.id) ? -1000 : 0;
        const bf = focusId >= 0 && activeSet.has(b.n.id) ? -1000 : 0;
        if (af !== bf) return af - bf;
        if (a.n.tier !== b.n.tier) return a.n.tier - b.n.tier;
        return a.pr.w - b.pr.w;
      });

      const placedBoxes = [];
      let used = 0;
      // 一屏塞不下十几条字：远处只留组名，凑近了再逐条浮出。
      // 700 是竖屏默认视距（dist），往下一档一档放开，最多放满 labelMax。
      const minKeep = nodes.filter((n) => n.tier <= 1).length;
      const zoomMax = Math.max(minKeep, 6 + Math.round(clamp((700 - cam.dist) / 480, 0, 1) * 24));
      for (let i = 0; i < order.length && used < Math.min(labelMax, zoomMax); i++) {
        const { n, pr } = order[i];
        if (focusId >= 0 && !activeSet.has(n.id) && n.tier > 0) continue;
        if (!n.label) continue;
        const el = pool[used];
        el.textContent = n.label;
        el.className = "memory-map-label t" + n.tier + (focusId === n.id ? " on" : "");
        const wpx = el.offsetWidth || 40;
        const hpx = el.offsetHeight || 14;
        let x, y;
        if (n.tier === 0) {
          x = pr.sx - wpx / 2;
          y = pr.sy + 21;
        } else {
          // 竖河把组名钉在左岸，标签再往左摆就直接压到组名上，
          // 避让撞车后整条标签被藏掉——十四件事只剩七条字，就是这里丢的。
          const right = n.tier === 1 ? false : pr.sx >= W * 0.52;
          const gapPx = n.tier === 1 ? 22 : 12;
          // 组名钉同一条右对齐轴：长短不一的组名各自贴着锚点摆，站出来是锯齿
          x = n.tier === 1 ? 96 - wpx : (right ? pr.sx + gapPx : pr.sx - gapPx - wpx);
          y = pr.sy - hpx / 2;
        }
        const wide = W > H * 1.2, maxStep = wide ? 7 : 6, maxOff = wide ? 38 : 46;
        const clash = (yy) => placedBoxes.some((b) =>
          x < b.x + b.w + 3 && x + wpx + 3 > b.x && yy < b.y + b.h + 2 && yy + hpx + 2 > b.y);
        if (clash(y)) {
          const y0 = y;
          let done = false;
          for (let step = 1; step <= maxStep && !done; step++) {
            const down = y0 + step * (hpx + 7);
            if (down + hpx < H - 4 && !clash(down)) { y = down; done = true; break; }
            const up = y0 - step * (hpx + 7);
            if (up > 4 && !clash(up)) { y = up; done = true; break; }
          }
          if (!done) { el.style.opacity = "0"; el.textContent = ""; continue; }
          if (Math.abs(y - y0) > maxOff) { el.style.opacity = "0"; el.textContent = ""; continue; }
        }
        if (x + wpx > W - 4) x = pr.sx - 16 - wpx;
        if (x < 4) x = pr.sx + 16;
        if (y > H - 20 || y < 2 || x < 0 || x + wpx > W) { el.style.opacity = "0"; el.textContent = ""; continue; }
        placedBoxes.push({ x, y, w: wpx, h: hpx });
        const fogA = n.tier === 0 ? 1 : clamp(1.42 - pr.w / (cam.dist * 1.45), 0.62, 1);
        el.style.transform = "translate3d(" + Math.round(x) + "px," + Math.round(y) + "px,0)";
        el.style.opacity = String(fogA.toFixed(2));
        used++;
      }
      for (let i = used; i < LABEL_POOL_MAX; i++) pool[i].style.opacity = "0";
      return order;
    }

    // ── 状态 ──
    let mode = options.layout && LAYOUTS[options.layout] ? options.layout : "shell";
    let animT = 1;
    let layoutAt = 0;
    let settled = true;
    let lastRC = null;
    let fogNear = 400, fogFar = 1600;
    let hoverId = -1;
    let raf = 0;
    let lastT = 0;
    let running = true;

    const snapPositions = () => { for (const n of nodes) { n.x = n.tx; n.y = n.ty; n.z = n.tz; } };

    // 观众窗口是横的（1054×414 这种），球壳/球冠在等比例投影下只能填满高度，
    // 横向永远空一大半。这里按容器纵横比把布局横向铺开：只拉 x，不裁剪，
    // 视觉上变成「星系盘」而不是一个瘦球。竖窗口（H>W）不处理。
    function stretchWide() {
      const aspect = W / Math.max(1, H);
      const ax = clamp(aspect / 1.05, 1, 2.6);
      if (ax <= 1.02) return;
      for (const n of nodes) if (n.tier > 0) n.tx *= ax;
    }

    function applyLayout(name, replay, resetView) {
      const fn = LAYOUTS[name] || LAYOUTS.shell;
      if (replay) for (const n of nodes) { n.x = 0; n.y = 0; n.z = 0; }
      if (replay || resetView) { animT = 0; layoutAt = performance.now(); }
      settled = false;
      fn();
      stretchWide();
      fitCamera();
      if (resetView) {
        const v = VIEW_OF[name] || VIEW_OF.shell;
        cam.yaw = v.yaw; cam.pitch = v.pitch;
        cam.yawVel = 0; cam.pitchVel = 0;
        cam.panXGoal = 0; cam.panYGoal = 0;
      }
      recenter();
      computeView();
    }

    function frame(now) {
      if (!running) return;
      raf = requestAnimationFrame(frame);
      if (W < 2 || H < 2) return;
      const dtReal = lastT ? Math.min(0.05, (now - lastT) / 1000) : 0.016;
      lastT = now;
      const dt = dtReal;

      cam.yawVel *= Math.pow(0.0025, dt);
      cam.pitchVel *= Math.pow(0.0025, dt);
      cam.yaw += cam.yawVel * dt;
      cam.pitch = clamp(cam.pitch + cam.pitchVel * dt, -1.45, 1.45);
      cam.dist = lerp(cam.dist, cam.distGoal, 1 - Math.pow(0.004, dt));
      cam.panX = lerp(cam.panX, cam.panXGoal, 1 - Math.pow(0.004, dt));
      cam.panY = lerp(cam.panY, cam.panYGoal, 1 - Math.pow(0.004, dt));

      if (animT < 1) {
        // 用真实时间推进，不用帧计数：软渲染（SwiftShader）只有 2 fps 时，
        // 按帧累加会让一次布局过渡拖十几秒，看着像卡住
        animT = Math.min(1, (now - layoutAt) / 1150);
        const e = easeOutExpo(animT);
        for (const n of nodes) {
          n.x = lerp(n.x, n.tx, Math.min(1, e * 1.06));
          n.y = lerp(n.y, n.ty, Math.min(1, e * 1.06));
          n.z = lerp(n.z, n.tz, Math.min(1, e * 1.06));
        }
        if (animT >= 0.999) snapPositions();
      } else {
        snapPositions();
        // 节点真正落到目标位置后再校一次构图：resize 高发期 RO 会连打好几次
        // applyLayout，中间态算出来的包围盒不准，只信落定后的那一帧
        if (!settled) { settled = true; recenter(); }
      }

      fogNear = cam.dist * 0.42;
      fogFar = cam.dist * 2.35;

      for (const n of nodes) {
        let a = 1;
        if (focusId >= 0) a = activeSet.has(n.id) ? 1 : 0.055;
        if (hoverId >= 0 && focusId < 0) {
          const isHover = n.id === hoverId;
          const isKin = nodes[hoverId].parent === n.id || (nodes[n.id] && nodes[n.id].parent === hoverId);
          a = isHover ? 1 : isKin ? 0.85 : 0.16;
        }
        n.alpha = a;
        ptAlpha[n.id] = a;
        ptPos[n.id * 3] = n.x;
        ptPos[n.id * 3 + 1] = n.y;
        ptPos[n.id * 3 + 2] = n.z;
      }

      for (let s = 0; s < LINE_SEG; s++) {
        const a = links[s][0], b = links[s][1];
        lnPos[s * 6] = nodes[a].x; lnPos[s * 6 + 1] = nodes[a].y; lnPos[s * 6 + 2] = nodes[a].z;
        lnPos[s * 6 + 3] = nodes[b].x; lnPos[s * 6 + 4] = nodes[b].y; lnPos[s * 6 + 5] = nodes[b].z;
        const base = nodes[a].tier === 1 ? 0.07 : 0.012;
        lnAlpha[s * 2] = base * nodes[a].alpha;
        lnAlpha[s * 2 + 1] = base * nodes[b].alpha;
      }
      // 联想线：比树线更淡，只在两端都还亮的时候看得见
      for (let s = 0; s < EXTRA_SEG; s++) {
        const i = LINE_SEG + s;
        const { a, b, weight } = extras[s];
        lnPos[i * 6] = nodes[a].x; lnPos[i * 6 + 1] = nodes[a].y; lnPos[i * 6 + 2] = nodes[a].z;
        lnPos[i * 6 + 3] = nodes[b].x; lnPos[i * 6 + 4] = nodes[b].y; lnPos[i * 6 + 5] = nodes[b].z;
        const base = 0.20 + 0.24 * clamp(weight, 0, 1);
        lnAlpha[i * 2] = base * nodes[a].alpha;
        lnAlpha[i * 2 + 1] = base * nodes[b].alpha;
      }

      gl.bindBuffer(gl.ARRAY_BUFFER, bPtPos); gl.bufferSubData(gl.ARRAY_BUFFER, 0, ptPos);
      gl.bindBuffer(gl.ARRAY_BUFFER, bPtAlpha); gl.bufferSubData(gl.ARRAY_BUFFER, 0, ptAlpha);
      gl.bindBuffer(gl.ARRAY_BUFFER, bLnPos); gl.bufferSubData(gl.ARRAY_BUFFER, 0, lnPos);
      gl.bindBuffer(gl.ARRAY_BUFFER, bLnAlpha); gl.bufferSubData(gl.ARRAY_BUFFER, 0, lnAlpha);

      computeView();
      mulMat(mvpMat, projMat, viewMat);
      const projScale = (canvas.height * 0.5) / Math.tan(fov / 2);

      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0.055, 0.043, 0.110, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE); // 加法混合：后面的东西透成光，而不是被挡住

      gl.useProgram(progLine);
      gl.uniformMatrix4fv(LU.mvp, false, mvpMat);
      gl.uniform1f(LU.fogNear, fogNear);
      gl.uniform1f(LU.fogFar, fogFar);

      const bindLine = (bPos, bCol, bAlpha) => {
        gl.bindBuffer(gl.ARRAY_BUFFER, bPos);
        gl.enableVertexAttribArray(aLine.pos);
        gl.vertexAttribPointer(aLine.pos, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, bCol);
        gl.enableVertexAttribArray(aLine.col);
        gl.vertexAttribPointer(aLine.col, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, bAlpha);
        gl.enableVertexAttribArray(aLine.alpha);
        gl.vertexAttribPointer(aLine.alpha, 1, gl.FLOAT, false, 0, 0);
      };

      bindLine(bLnPos, bLnCol, bLnAlpha);
      gl.drawArrays(gl.LINES, 0, (LINE_SEG + EXTRA_SEG) * 2);

      if (decorCount > 0) {
        bindLine(bDcPos, bDcCol, bDcAlpha);
        gl.drawArrays(gl.LINES, 0, decorCount);
      }

      gl.useProgram(progPoint);
      gl.uniformMatrix4fv(PU.mvp, false, mvpMat);
      gl.uniform1f(PU.projScale, projScale);
      gl.uniform1f(PU.fogNear, fogNear);
      gl.uniform1f(PU.fogFar, fogFar);

      gl.bindBuffer(gl.ARRAY_BUFFER, bPtPos);
      gl.enableVertexAttribArray(aPoint.pos);
      gl.vertexAttribPointer(aPoint.pos, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, bPtCol);
      gl.enableVertexAttribArray(aPoint.col);
      gl.vertexAttribPointer(aPoint.col, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, bPtSize);
      gl.enableVertexAttribArray(aPoint.size);
      gl.vertexAttribPointer(aPoint.size, 1, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, bPtAlpha);
      gl.enableVertexAttribArray(aPoint.alpha);
      gl.vertexAttribPointer(aPoint.alpha, 1, gl.FLOAT, false, 0, 0);

      if (glowOn) {
        gl.uniform1f(PU.glow, 1);
        gl.drawArrays(gl.POINTS, 0, N);
      }
      gl.uniform1f(PU.glow, 0);
      gl.drawArrays(gl.POINTS, 0, N);

      updateLabels();
    }

    // ── 输入 ──
    const pointers = new Map();
    let dragMode = null, lastX = 0, lastY = 0, moved = 0;
    let pinchStartDist = 0, pinchStartCamDist = 0;

    function hitTest(sx, sy) {
      const thresh = 22;
      let best = -1, bestW = 1e9;
      for (const n of nodes) {
        const pr = n._pr;
        if (!pr) continue;
        if (focusId >= 0 && !activeSet.has(n.id)) continue;
        const d = Math.hypot(pr.sx - sx, pr.sy - sy);
        if (d < thresh && pr.w < bestW) { best = n.id; bestW = pr.w; }
      }
      return best;
    }

    const onDown = (ev) => {
      canvas.setPointerCapture(ev.pointerId);
      pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      moved = 0;
      if (pointers.size === 1) {
        dragMode = ev.button === 2 || ev.shiftKey ? "pan" : "orbit";
        lastX = ev.clientX; lastY = ev.clientY;
      } else if (pointers.size === 2) {
        dragMode = "pinch";
        const arr = [...pointers.values()];
        pinchStartDist = Math.hypot(arr[0].x - arr[1].x, arr[0].y - arr[1].y) || 1;
        pinchStartCamDist = cam.distGoal;
      }
    };

    const localXY = (ev) => {
      const r = canvas.getBoundingClientRect();
      return { x: ev.clientX - r.left, y: ev.clientY - r.top };
    };

    const onMove = (ev) => {
      const prev = pointers.get(ev.pointerId);
      if (prev) { prev.x = ev.clientX; prev.y = ev.clientY; }
      if (dragMode === "orbit" && pointers.size === 1) {
        const dx = ev.clientX - lastX, dy = ev.clientY - lastY;
        moved += Math.abs(dx) + Math.abs(dy);
        lastX = ev.clientX; lastY = ev.clientY;
        cam.yawVel = -dx * 0.010;
        cam.pitchVel = dy * 0.008;
      } else if (dragMode === "pan" && pointers.size === 1) {
        const dx = ev.clientX - lastX, dy = ev.clientY - lastY;
        moved += Math.abs(dx) + Math.abs(dy);
        lastX = ev.clientX; lastY = ev.clientY;
        const k = cam.dist * 0.0016;
        cam.panXGoal -= dx * k;
        cam.panYGoal += dy * k;
      } else if (dragMode === "pinch" && pointers.size === 2) {
        const arr = [...pointers.values()];
        const d = Math.hypot(arr[0].x - arr[1].x, arr[0].y - arr[1].y) || 1;
        cam.distGoal = clamp(pinchStartCamDist * (pinchStartDist / d), 220, 4200);
      } else {
        const p = localXY(ev);
        hoverId = hitTest(p.x, p.y);
        canvas.style.cursor = hoverId >= 0 ? "pointer" : "grab";
      }
    };

    const endPointer = (ev) => {
      pointers.delete(ev.pointerId);
      if (pointers.size === 0) {
        if (dragMode === "orbit" && moved < 6) {
          const p = localXY(ev);
          const id = hitTest(p.x, p.y);
          setFocus(id >= 0 ? (id === focusId ? -1 : id) : -1);
        }
        dragMode = null;
      } else if (pointers.size === 1) {
        dragMode = "orbit";
        const arr = [...pointers.values()];
        lastX = arr[0].x; lastY = arr[0].y;
      }
    };

    const onWheel = (ev) => {
      ev.preventDefault();
      cam.distGoal = clamp(cam.distGoal * Math.exp(ev.deltaY * 0.0011), 220, 4200);
    };

    const resetView = () => {
      setFocus(-1);
      hoverId = -1;
      const v = VIEW_OF[mode] || VIEW_OF.shell;
      cam.yaw = v.yaw; cam.pitch = v.pitch;
      cam.yawVel = 0; cam.pitchVel = 0;
      cam.panXGoal = 0; cam.panYGoal = 0;
      fitCamera();
      recenter();
    };

    const onDouble = () => { setFocus(-1); resetView(); };
    const onCtx = (ev) => ev.preventDefault();
    const onLeave = () => { hoverId = -1; };

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", endPointer);
    canvas.addEventListener("pointercancel", endPointer);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("dblclick", onDouble);
    canvas.addEventListener("contextmenu", onCtx);
    canvas.style.cursor = "grab";

    // ── 启动 ──
    resize();
    applyLayout(mode, true, true);
    cam.dist = cam.distGoal;
    started = true;
    raf = requestAnimationFrame(frame);

    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => {
      if (!resize()) return;
      applyLayout(mode, false, false);
    }) : null;
    if (ro) ro.observe(container);

    // 面板关掉/切走就别再跑 rAF，SwiftShader 下空转会一直吃 CPU
    const io = typeof IntersectionObserver === "function" ? new IntersectionObserver((entries) => {
      const visible = entries.some((e) => e.isIntersecting);
      running = visible;
      if (visible && !raf) { lastT = 0; raf = requestAnimationFrame(frame); }
    }) : null;
    if (io) io.observe(container);

    return {
      ok: true,
      setLayout(name) {
        if (!LAYOUTS[name]) return;
        mode = name;
        setFocus(-1);
        applyLayout(mode, false, true);
      },
      reset: resetView,
      getMode: () => mode,
      getCounts: () => ({ nodes: N, links: LINE_SEG, extras: EXTRA_SEG, tier: tierName }),
      // 调构图用：改完 margin/k 想看数字别靠肉眼估
      debug() {
        computeView();
        let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9, off = 0;
        for (const n of nodes) {
          const p = project(n.x, n.y, n.z);
          if (!p) { off++; continue; }
          if (p.sx < minX) minX = p.sx;
          if (p.sx > maxX) maxX = p.sx;
          if (p.sy < minY) minY = p.sy;
          if (p.sy > maxY) maxY = p.sy;
        }
        return {
          W, H, fov: Number(fov.toFixed(3)), dist: Math.round(cam.dist), distGoal: Math.round(cam.distGoal),
          panX: Math.round(cam.panX), panY: Math.round(cam.panY), offscreen: off,
          running, animT: Number(animT.toFixed(2)), lastRC,
          bbox: { minX: Math.round(minX), maxX: Math.round(maxX), minY: Math.round(minY), maxY: Math.round(maxY) },
          fillX: Number(((maxX - minX) / Math.max(1, W)).toFixed(3)),
          fillY: Number(((maxY - minY) / Math.max(1, H)).toFixed(3)),
          centerDX: Math.round((minX + maxX) / 2 - W / 2),
          centerDY: Math.round((minY + maxY) / 2 - H / 2),
        };
      },
      destroy() {
        running = false;
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        if (ro) ro.disconnect();
        if (io) io.disconnect();
        canvas.removeEventListener("pointerdown", onDown);
        canvas.removeEventListener("pointermove", onMove);
        canvas.removeEventListener("pointerup", endPointer);
        canvas.removeEventListener("pointercancel", endPointer);
        canvas.removeEventListener("pointerleave", onLeave);
        canvas.removeEventListener("wheel", onWheel);
        canvas.removeEventListener("dblclick", onDouble);
        canvas.removeEventListener("contextmenu", onCtx);
        try {
          const lose = gl.getExtension("WEBGL_lose_context");
          if (lose) lose.loseContext();
        } catch { /* 丢不丢上下文都不影响面板关掉 */ }
        canvas.remove();
        labelLayer.remove();
      },
    };
  }

  // ── 对外接口 ─────────────────────────────────────────────
  let current = null;
  let currentEl = null;

  function unmount() {
    if (current && typeof current.destroy === "function") {
      try { current.destroy(); } catch { /* 销毁失败也要清引用 */ }
    }
    current = null;
    currentEl = null;
  }

  window.EllenMemoryMap = {
    mount(container, payload, opts) {
      if (!container) return null;
      unmount();
      try {
        current = createScene(container, payload || { nodes: [], edges: [] }, opts || {});
      } catch (err) {
        const tip = document.createElement("p");
        tip.className = "memory-map-fallback";
        tip.textContent = "星图没画出来：" + String((err && err.message) || err);
        container.append(tip);
        current = { destroy() { tip.remove(); }, setLayout() {}, reset() {}, getMode: () => "shell", getCounts: () => null, ok: false };
      }
      currentEl = container;
      return current;
    },
    unmount,
    setLayout(name) { if (current) current.setLayout(name); },
    reset() { if (current && typeof current.reset === "function") current.reset(); },
    getMode() { return current ? current.getMode() : null; },
    debug() { return current && typeof current.debug === "function" ? current.debug() : null; },
    getCounts() { return current ? current.getCounts() : null; },
  };
})();
  /* ------------------------- 手机版：数据层与面板 ------------------------- */
/* ============================================================================
 * 手机版：记忆星图（数据层 + 全屏面板 + 入口）
 * ----------------------------------------------------------------------------
 * 这段由 _临时\记忆星图\build-phone-inject.cjs 拼进 inject-memory-map.js，
 * 位置在「渲染层（电脑版 memory-map.js 原文）」之后，共用同一个 IIFE。
 * 依赖：window.EllenMemoryMap（渲染层已挂好）
 * 铁律：只读宿主 IndexedDB，不写、不升级、不建库。
 * ========================================================================== */
(function () {
  "use strict";
  var MAP = window.__ellenMemoryMap;
  if (!MAP || MAP.ready) return;
  MAP.ready = true;

  var DB_NAME = "ellen-mobile-data-v1";
  var HUES = ["#57c7b8", "#e0a13c", "#d96b85", "#6f8fe8", "#a07fe0", "#8fbf62", "#e08a5c"];

  /* ---------------------------------------------------------------- 读库 */
  function peekDb() {
    return new Promise(function (resolve) {
      var settled = false;
      var finish = function (db) {
        if (settled) return;
        settled = true;
        resolve(db || null);
      };
      var req;
      try {
        req = window.indexedDB.open(DB_NAME);
      } catch (e) {
        return finish(null);
      }
      var created = false;
      req.onupgradeneeded = function () {
        created = true;
        try {
          req.transaction.abort();
        } catch (e) {}
      };
      req.onsuccess = function () {
        var db = req.result;
        if (created) {
          try {
            db.close();
          } catch (e) {}
          try {
            window.indexedDB.deleteDatabase(DB_NAME);
          } catch (e) {}
          return finish(null);
        }
        finish(db);
      };
      req.onerror = function () {
        finish(null);
      };
      req.onblocked = function () {
        finish(null);
      };
      window.setTimeout(function () {
        finish(null);
      }, 2600);
    });
  }

  var PROFILE_KEYS = [
    "ellen-mobile-active-profile",
    "ellen.mobile.active-profile",
    "ellen-active-profile",
  ];

  function activeProfileId() {
    for (var i = 0; i < PROFILE_KEYS.length; i++) {
      try {
        var v = window.localStorage.getItem(PROFILE_KEYS[i]);
        if (v && v.length > 1 && v.length < 120 && v.indexOf("{") < 0) return v;
      } catch (e) {}
    }
    return null;
  }

  /** 扫 data-heads 拿全部 kind=memory 的 head（只读游标，不写库）。 */
  function readMemoryHeads(db, profileId) {
    return new Promise(function (resolve) {
      var out = [];
      var tx;
      try {
        tx = db.transaction(["data-heads"], "readonly");
      } catch (e) {
        return resolve(out);
      }
      var req;
      try {
        req = tx.objectStore("data-heads").openCursor();
      } catch (e) {
        return resolve(out);
      }
      req.onsuccess = function () {
        var cur = req.result;
        if (!cur) return;
        var v = cur.value;
        if (v && v.kind === "memory" && !v.deleted) {
          if (!profileId || v.profileId === profileId) out.push(v);
        }
        try {
          cur.continue();
        } catch (e) {}
      };
      req.onerror = function () {
        resolve(out);
      };
      tx.oncomplete = function () {
        resolve(out);
      };
      tx.onabort = function () {
        resolve(out);
      };
      window.setTimeout(function () {
        resolve(out);
      }, 4000);
    });
  }

  /** 对每个 head 取当前 revision 的 value。 */
  function readValues(db, heads) {
    return new Promise(function (resolve) {
      if (!heads.length) return resolve([]);
      var tx;
      try {
        tx = db.transaction(["data-revisions"], "readonly");
      } catch (e) {
        return resolve([]);
      }
      var idx;
      try {
        idx = tx.objectStore("data-revisions").index("recordId");
      } catch (e) {
        return resolve([]);
      }
      var out = new Array(heads.length);
      var left = heads.length;
      var done = function () {
        if (--left === 0) resolve(out);
      };
      heads.forEach(function (h, i) {
        var want = h.revisionId || h.currentRevisionId || null;
        var r;
        try {
          r = idx.getAll(h.id);
        } catch (e) {
          out[i] = null;
          return done();
        }
        r.onsuccess = function () {
          var list = r.result || [];
          var pick = null;
          for (var k = 0; k < list.length; k++) {
            if (want && list[k] && list[k].revisionId === want) pick = list[k];
          }
          if (!pick) pick = list[list.length - 1] || null;
          var val = (pick && pick.value) || null;
          out[i] = val && typeof val === "object" ? val : null;
          done();
        };
        r.onerror = function () {
          out[i] = null;
          done();
        };
      });
      tx.onabort = function () {
        resolve(out);
      };
      window.setTimeout(function () {
        resolve(out);
      }, 4500);
    });
  }

  /* ------------------------------------------------------------ 建图逻辑 */
  /* 与电脑版 memory/src/memory-graph.cjs 同规则，只是手机版没有边表：
     图里只有「她记得的事 → 组 → 记忆」两层线，没有横向联想线。 */

  function clamp01(v) {
    var n = typeof v === "number" ? v : Number(v);
    if (!isFinite(n)) return 0;
    return n < 0 ? 0 : n > 1 ? 1 : n;
  }

  var KIND_FALLBACK = {
    user_fact: "关于你的事",
    shared_event: "一起经历的事",
    knowledge: "她知道的",
  };

  /** 标题首段当实体名：「楼下的猫 · 雨天」→「楼下的猫」。 */
  function entityOf(title) {
    var t = String(title || "").trim();
    if (!t) return null;
    var head = t.split(/[·・|｜/／]/)[0].trim();
    if (head.length < 2 || head === t) return null;
    return head;
  }

  function shortLabel(s, max) {
    var t = String(s || "").replace(/\s+/g, " ").trim();
    if (t.length <= max) return t;
    return t.slice(0, Math.max(1, max - 1)) + "…";
  }

  /* 记忆标题普遍写成「组名 · 具体事」，组名已经由一级节点承担了。
     叶子再带一遍前缀，二级标签读起来就和一级一样重，层次全糊——所以这里削掉。 */
  function stripGroupPrefix(title, gkey) {
    var t = String(title || "");
    if (!gkey) return t;
    if (t.indexOf(gkey) === 0) {
      var rest = t.slice(gkey.length).replace(/^[\s·・|｜/／\-–—:：]+/, "");
      if (rest) return rest;
    }
    return t;
  }

  function strengthOf(m) {
    var conf = typeof m.confidence === "number" ? m.confidence : 0.7;
    var ar = typeof m.arousal === "number" ? m.arousal : 0.6;
    var base = typeof m.baseStrength === "number" ? m.baseStrength : 1;
    var bump = base > 1 ? Math.min(0.3, (base - 1) * 0.15) : 0;
    return clamp01(0.15 + 0.85 * clamp01(conf) * (0.55 + 0.45 * clamp01(ar)) + bump);
  }

  function weightOf(m) {
    return 0.55 + 0.95 * strengthOf(m);
  }

  function buildGraph(memories, rootLabel) {
    var list = (memories || []).slice();
    list.sort(function (a, b) {
      var wa = weightOf(a);
      var wb = weightOf(b);
      if (wa !== wb) return wb - wa;
      return String(a.at || "") < String(b.at || "") ? 1 : -1;
    });
    var groups = {};
    var order = [];
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      var key = entityOf(m.title);
      var fromEntity = !!key;
      if (!key) key = KIND_FALLBACK[m.kind] || "零散的事";
      if (!groups[key]) {
        groups[key] = { key: key, items: [], w: 0, ent: fromEntity };
        order.push(key);
      }
      groups[key].items.push(m);
      groups[key].w += weightOf(m);
    }
    /* 孤零零一条的实体组会被读成「又一个组名」，其实它只是那一件事：
       并回它所属的 kind 组，让组名保持同一粒度。 */
    for (var oi = order.length - 1; oi >= 0; oi--) {
      var kk = order[oi];
      var gg = groups[kk];
      if (!gg || !gg.ent || gg.items.length !== 1) continue;
      var fallback = KIND_FALLBACK[gg.items[0].kind] || "零散的事";
      if (fallback === kk) continue;
      if (!groups[fallback]) {
        groups[fallback] = { key: fallback, items: [], w: 0 };
        order.push(fallback);
      }
      groups[fallback].items = groups[fallback].items.concat(gg.items);
      groups[fallback].w += gg.w;
      delete groups[kk];
      order.splice(oi, 1);
    }
    order.sort(function (a, b) {
      return groups[b].w - groups[a].w;
    });
    var MAX = 7;
    if (order.length > MAX) {
      /* 「别的」既是兜底名也可能本来就是个组名：先把它从保留位剔掉再全部并进同一个舱，
         否则同一屏会出现两个「别的」。 */
      var keep = order.slice(0, MAX - 1).filter(function (k) { return k !== "别的"; });
      var rest = order.filter(function (k) { return keep.indexOf(k) < 0; });
      var other = { key: "别的", items: [], w: 0 };
      for (var r = 0; r < rest.length; r++) {
        var g = groups[rest[r]];
        if (!g) continue;
        other.items = other.items.concat(g.items);
        other.w += g.w;
        delete groups[rest[r]];
      }
      groups["别的"] = other;
      order = keep.concat(["别的"]);
    }

    var leafSeq = 0;
    var nodes = [{ key: "root", label: rootLabel, w: 1, tier: 0, parent: -1, color: "#eef4ff" }];
    var links = [];
    var gi = 0;
    for (var o = 0; o < order.length; o++) {
      var grp = groups[order[o]];
      var gIdx = nodes.length;
      var gW = 1 + Math.min(1.2, 0.32 * grp.items.length);
      nodes.push({
        key: "g:" + grp.key,
        label: grp.key,
        w: gW,
        tier: 1,
        parent: 0,
        color: HUES[gi % HUES.length],
        count: grp.items.length,
      });
      links.push([0, gIdx]);
      for (var k = 0; k < grp.items.length; k++) {
        var mm = grp.items[k];
        nodes.push({
          key: "m:" + (mm.id || k),
          label: shortLabel(stripGroupPrefix(mm.title, grp.key), 14),
          /* 组内按序号给阶梯权重，而不是按全局每三条加一档：
             渲染层按「焦点 > 层级 > 权重」依次抢标签坑位，一屏只挂得下十来条，
             阶梯权重保证每组稳定露面前两条，第三四条沉底——不这么做，
             藏起来的那几条每次都换人，看起来像随机没有字。 */
          w: 1.55 - Math.min(3, k) * 0.3 + strengthOf(mm) * 0.22,
          tier: 2,
          parent: gIdx,
          groupIndex: gi,
          color: HUES[gi % HUES.length],
          kind: mm.kind,
          summary: mm.summary || "",
          anchorAt: mm.at || null,
        });
        leafSeq++;
        links.push([gIdx, nodes.length - 1]);
      }
      gi++;
    }
    // 河要把点串起来才有「时间在往下流」的意思：按时间给相邻两条记忆拉一根线
    var leafIdx = [];
    for (var li = 0; li < nodes.length; li++) if (nodes[li].tier === 2) leafIdx.push(li);
    leafIdx.sort(function (a, b) {
      var ta = String(nodes[a].anchorAt || "");
      var tb = String(nodes[b].anchorAt || "");
      if (ta && tb && ta !== tb) return ta < tb ? 1 : -1;
      return a - b;
    });
    var chain = [];
    for (var lj = 1; lj < leafIdx.length; lj++) {
      chain.push({ a: leafIdx[lj - 1], b: leafIdx[lj], kind: "temporal", weight: 0.78, label: "接着发生" });
    }
    return {
      nodes: nodes,
      links: links,
      edges: chain,
      extras: [],
      meta: {
        memories: list.length,
        groups: order.length,
        edges: chain.length,
        rootLabel: rootLabel,
        generatedAt: new Date().toISOString(),
      },
    };
  }

  /* ------------------------------------------------------------ 样式注入 */
  var CSS_ID = "ellen-memory-map-style";
  /* 手机版尺寸规矩：纵向用 vmin；Npx → clamp(N*0.84px, N*0.2315vmin, N*1.16px) */
  var CSS = [
    ".emm-sheet{position:fixed;inset:0;z-index:2147483000;display:none;flex-direction:column;",
    "background:radial-gradient(120% 90% at 50% 0%,#141024 0%,#0b0913 52%,#07060d 100%);",
    "padding-top:calc(env(safe-area-inset-top,0px) + clamp(25px,6.9vmin,34px));padding-bottom:env(safe-area-inset-bottom,0px);}",
    ".emm-sheet.on{display:flex;}",
    ".emm-head{display:flex;align-items:center;gap:clamp(6.7px,1.85vmin,9.3px);",
    "padding:clamp(8.4px,2.31vmin,11.6px) clamp(12.6px,3.47vmin,17.4px);}",
    ".emm-back{width:clamp(28.6px,7.87vmin,39.4px);height:clamp(28.6px,7.87vmin,39.4px);",
    "border-radius:50%;border:1px solid rgba(180,150,190,.28);background:rgba(40,32,54,.7);",
    "color:#e8e2f0;font-size:clamp(13.4px,3.7vmin,18.6px);line-height:1;display:flex;",
    "align-items:center;justify-content:center;flex:none;}",
    ".emm-title{font-weight:600;font-size:clamp(14.3px,3.94vmin,19.7px);line-height:1.3;color:#f4eef8;}",
    ".emm-sub{margin:0;font-weight:400;font-size:clamp(9.2px,2.55vmin,12.8px);line-height:1.5;",
    "color:rgba(206,196,220,.72);}",
    ".emm-stage{position:relative;flex:1;margin:0 clamp(12.6px,3.47vmin,17.4px);",
    "border-radius:clamp(10.9px,3vmin,15.1px);overflow:hidden;",
    "border:1px solid rgba(150,132,168,.26);background:radial-gradient(120% 130% at 50% 8%,#171330 0%,#0d0b18 54%,#07060d 100%);",
    "touch-action:none;}",
    ".emm-rail{position:absolute;right:clamp(4px,1.1vmin,6px);top:clamp(10px,2.6vmin,13.5px);bottom:clamp(10px,2.6vmin,13.5px);display:flex;flex-direction:column;justify-content:space-between;pointer-events:none;z-index:2;}",
    ".emm-rail span{writing-mode:vertical-rl;text-orientation:upright;font-size:clamp(9.2px,2.3vmin,11.6px);letter-spacing:.24em;color:rgba(214,188,208,.66);}",
    ".emm-bar{display:flex;align-items:center;justify-content:flex-end;",
    "padding:clamp(8.4px,2.31vmin,11.6px) clamp(12.6px,3.47vmin,17.4px)",
    " calc(clamp(12.6px,3.47vmin,17.4px) + env(safe-area-inset-bottom,0px));}",
    /* 点开一颗星时从底部浮出的卡片：手机不靠「聚焦放大」讲详情，就靠这张卡 */
    ".emm-detail{position:absolute;left:clamp(9.2px,2.55vmin,12.8px);right:clamp(9.2px,2.55vmin,12.8px);",
    "bottom:clamp(9.2px,2.55vmin,12.8px);z-index:3;border-radius:clamp(10.9px,3vmin,15.1px);",
    "border:1px solid rgba(240,206,224,.3);",
    "background:linear-gradient(180deg,rgba(40,32,55,.96) 0%,rgba(26,21,38,.97) 55%,rgba(16,13,24,.98) 100%);",
    "padding:clamp(9.2px,2.55vmin,12.8px) clamp(11.8px,3.24vmin,16.3px);",
    "box-shadow:0 -30px 36px -6px rgba(7,6,14,.94),0 -6px 14px rgba(7,6,14,.7),0 10px 30px rgba(0,0,0,.5);transform:translateY(calc(100% + 14px));",
    "opacity:0;transition:transform .26s ease,opacity .26s ease;pointer-events:none;}",
    ".emm-detail.on{transform:translateY(0);opacity:1;pointer-events:auto;}",
    ".emm-detail b{display:block;font-weight:600;font-size:clamp(10.1px,2.78vmin,14px);",
    "line-height:1.45;color:#f6eef8;}",
    ".emm-detail p{margin:clamp(2.5px,.69vmin,3.4px) 0 0;font-weight:400;",
    "font-size:clamp(8.8px,2.43vmin,12.2px);line-height:1.6;color:rgba(220,210,232,.8);",
    "display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;}",
    ".emm-detail em{display:block;margin-top:clamp(3.4px,.93vmin,4.6px);font-style:normal;",
    "font-size:clamp(8.4px,2.31vmin,11.6px);line-height:1.4;color:rgba(206,190,216,.62);}",
    ".emm-btn{padding:clamp(5px,1.4vmin,7px) clamp(8.4px,2.31vmin,11.6px);",
    "border-radius:999px;border:1px solid rgba(150,132,168,.5);background:rgba(44,36,58,.82);",
    "color:#dcd4e6;font-size:clamp(9.2px,2.55vmin,12.8px);line-height:1.4;font-weight:500;}",
    ".emm-btn[aria-pressed=true]{background:linear-gradient(180deg,rgba(240,208,224,.94),rgba(206,158,186,.94));",
    "border-color:rgba(255,224,238,.8);color:#2a1f2a;}",
    ".emm-btn[disabled]{opacity:.34;}",
    ".emm-titles{flex:1;min-width:0;}",
    /* 回正是「动作」，跟四个「视图切换」不是一类，挪到标题行右侧当图标按钮 */
    ".emm-reset{width:clamp(28.6px,7.87vmin,39.4px);height:clamp(28.6px,7.87vmin,39.4px);",
    "flex:none;border-radius:50%;border:1px solid rgba(200,170,208,.46);",
    "background:rgba(40,32,54,.6);color:#d8cfe4;font-size:clamp(12.6px,3.47vmin,17.4px);line-height:1;}",
    ".emm-reset[disabled]{opacity:.28;}",
    ".emm-tip{flex:none;display:flex;align-items:baseline;justify-content:space-between;gap:clamp(7px,1.9vmin,9.6px);overflow:hidden;",
    "padding:clamp(4.6px,1.27vmin,6.4px) clamp(12.6px,3.47vmin,17.4px)",
    " calc(clamp(10px,2.6vmin,14px) + env(safe-area-inset-bottom,0px)) 0 0;",
    "font-size:clamp(8.4px,2.31vmin,11.6px);line-height:1.4;color:rgba(214,204,228,.58);}",
    ".emm-hint{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
    ".emm-tip .emm-count{flex:none;white-space:nowrap;}",
    ".emm-tip[hidden]{display:none;}",
    ".emm-sheet.no-data .emm-bar{display:none;}",
    ".emm-sheet.no-data .emm-reset{display:none;}",
    ".emm-sheet.no-data .emm-rail{display:none;}",
    /* 横屏的时间是横着走的：竖排「最近/最早」会跟左端的中心星撞在一起，
       改成贴在舞台顶边，左「最近」右「最早」，正好给横河当刻度尺。 */
    ".emm-sheet[data-mode=shell] .emm-rail{display:none;}",
    ".emm-count{margin-left:auto;font-size:clamp(9.2px,2.55vmin,12.8px);line-height:1.4;",
    "color:rgba(222,212,236,.78);}",
    ".emm-empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;",
    "justify-content:center;gap:clamp(5px,1.4vmin,7px);padding:clamp(16.8px,4.63vmin,23.2px);",
    "text-align:center;color:rgba(214,206,226,.8);}",
    ".emm-empty h3{margin:0;font-weight:600;font-size:clamp(13.4px,3.7vmin,18.6px);line-height:1.4;color:#f0e9f6;}",
    ".emm-empty p{margin:0;font-weight:400;font-size:clamp(9.2px,2.55vmin,12.8px);line-height:1.65;}",
    /* 空态骨架：几个待点亮的星位，让空面板看着像「还没亮」而不是「没渲染出来」 */
    ".emm-skeleton{position:absolute;inset:0;z-index:0;pointer-events:none;overflow:hidden;}",
    ".emm-skeleton i{position:absolute;width:clamp(3.4px,.93vmin,4.6px);height:clamp(3.4px,.93vmin,4.6px);",
    "border-radius:50%;background:rgba(206,186,222,.55);box-shadow:0 0 10px rgba(206,186,222,.36);}",
    ".emm-empty>h3,.emm-empty>p,.emm-empty>.emm-cta{position:relative;z-index:1;}",
    ".emm-cta{margin-top:clamp(8.4px,2.31vmin,11.6px);padding:clamp(8.4px,2.31vmin,11.6px) clamp(28.6px,7.87vmin,39.4px);",
    "min-width:52%;border-radius:999px;border:1px solid rgba(255,224,238,.72);font-weight:600;",
    "font-size:clamp(10.1px,2.78vmin,14px);line-height:1.4;color:#2a1f2a;letter-spacing:.04em;",
    "background:linear-gradient(180deg,rgba(240,208,224,.96),rgba(206,158,186,.96));}",
    ".emm-cta:active{filter:brightness(1.08);}",
    ".emm-entry{display:inline-flex;align-items:center;gap:clamp(3.4px,.93vmin,4.6px);",
    "padding:clamp(5px,1.4vmin,7px) clamp(9.2px,2.55vmin,12.8px);border-radius:999px;",
    "border:1px solid rgba(190,160,200,.42);background:rgba(48,40,62,.72);",
    "color:#e4dcee;font-size:clamp(9.2px,2.55vmin,12.8px);line-height:1.4;font-weight:500;}",
    ".emm-entry:active{background:rgba(240,208,224,.9);color:#2a1f2a;}",
    /* 入口按钮只属于「回忆 → 记忆」那排 tab。万一有谁把它塞进面板里（画布标签层的组名
       也叫「共同经历」，findTabRow 可能认错人），这里兜底藏掉，绝不让它浮在星图上。 */
    ".emm-sheet .emm-entry,.memory-map-labels .emm-entry{display:none!important;}",
  ].join("");

  /* 渲染层自带的 .memory-map-* 样式（电脑版用 rem，这里按 vmin 换算一遍） */
  var RENDER_CSS = [
    ".memory-map-shell{position:relative;width:100%;height:100%;overflow:hidden;",
    "background:transparent;touch-action:none;}",
    ".memory-map-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;outline:none;}",
    ".memory-map-labels{position:absolute;inset:0;pointer-events:none;overflow:hidden;}",
    ".memory-map-label{position:absolute;top:0;left:0;opacity:0;white-space:nowrap;line-height:1.35;",
    "font-weight:500;font-size:clamp(9.2px,2.6vmin,13.5px);padding:1px 3px;border-radius:4px;",
    "background:transparent;text-shadow:0 0 3px rgba(6,4,12,.95),0 0 7px rgba(6,4,12,.9),0 0 12px rgba(6,4,12,.75);",
    "color:rgba(232,236,248,.9);text-shadow:0 1px 3px rgba(4,6,14,.98),0 0 6px rgba(4,6,14,.95),0 0 12px rgba(4,6,14,.8);",
    "transition:opacity .18s ease-out;will-change:transform;}",
    ".memory-map-label.t0{font-weight:800;font-size:clamp(18px,6.2vmin,30px);line-height:1.22;",
    "letter-spacing:.02em;color:#fff;background:transparent;",
    "text-shadow:0 1px 3px rgba(4,6,14,.98),0 0 14px rgba(240,190,215,.75);}",
    ".memory-map-label.t1{font-weight:700;font-size:clamp(12px,3.15vmin,15px);color:#fff;",
    "background:transparent;letter-spacing:.03em;padding-left:9px;}",
    /* 组名前面挂一小段竖条：字号差得再少，也有个「这是个门牌，不是一件事」的记号。
       单条没有这条杠，一眼就能分开。 */
    ".memory-map-label.t1::before{content:'';position:absolute;left:-1px;top:50%;width:3.2px;height:3.2px;margin-top:-1.6px;border-radius:50%;",
    "transform:translateY(-50%);border-radius:1px;background:rgba(232,178,199,.85);}",
    ".memory-map-label.t2{font-weight:400;font-size:clamp(8.6px,2.2vmin,10.6px);color:rgba(232,236,248,.84);",
    ".memory-map-label.on{color:#fff;text-shadow:0 1px 3px rgba(4,10,20,.95),0 0 10px rgba(255,200,230,.55);}",
    ".memory-map-fallback{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;",
    "padding:clamp(12.6px,3.47vmin,17.4px);font-size:clamp(9.2px,2.55vmin,12.8px);",
    "color:rgba(214,206,226,.8);text-align:center;}",
  ].join("");

  function injectStyle() {
    if (document.getElementById(CSS_ID)) return;
    var st = document.createElement("style");
    st.id = CSS_ID;
    st.textContent = CSS + RENDER_CSS;
    (document.head || document.documentElement).append(st);
  }

  /* ------------------------------------------------------------ 全屏面板 */
  var sheet = null;
  var stage = null;
  var detailEl = null;
  var countEl = null;
  var rootLabelCache = "她记得的事";

  /* 底部详情卡：组显示「几件事」，记忆显示标题 + 摘要 + 时间 */
  function showDetail(node) {
    if (!detailEl || !node) return;
    var when = node.anchorAt ? String(node.anchorAt).slice(0, 10).replace(/-/g, " 年 ").replace(/ 年 (\d\d) 年 /, " 年 $1 月 ") + " 日" : "";
    var title = node.label || "";
    var body = "";
    var meta = "";
    if (node.tier === 1) {
      body = "这里有 " + (node.count || 0) + " 件事。点开看看，或者再点一下它收起来。";
    } else if (node.tier === 2) {
      body = node.summary || "这条她没有留下摘要。";
      meta = when;
    } else {
      body = "她记得的所有事都挂在这颗中心星上。点亮一个分支，看看里面有什么。";
    }
    detailEl.innerHTML =
      "<b>" + escapeHtml(title) + "</b>" +
      (body ? "<p>" + escapeHtml(body) + "</p>" : "") +
      (meta ? "<em>" + escapeHtml(meta) + "</em>" : "");
    detailEl.classList.add("on");
  }

  function hideDetail() {
    if (detailEl) detailEl.classList.remove("on");
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function characterName() {
    try {
      var t = document.title || "";
      if (t && t.length < 20) return t.replace(/[·|\-–].*$/, "").trim();
    } catch (e) {}
    return "艾莲";
  }

  function buildSheet() {
    if (sheet) return sheet;
    injectStyle();
    var el = document.createElement("div");
    el.className = "emm-sheet";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.innerHTML = [
      '<div class="emm-head">',
      '<button class="emm-back" type="button" aria-label="返回">‹</button>',
      '<div class="emm-titles">',
      '<div class="emm-title">记忆星图</div>',
      '<p class="emm-sub">由新到旧往下走，一条河就是她记得的这些天。</p>',      "</div>",
      '<button class="emm-reset" type="button" aria-label="回正">⟲</button>',
      "</div>",
      '<div class="emm-stage"><div class="emm-rail"><span>最近</span><span>最早</span></div><div class="emm-detail" role="status"></div></div>',
      '<div class="emm-tip" hidden><span class="emm-hint">点一颗星看内容 · 拖动浏览 · 双指缩放</span>',
      '<span class="emm-count"></span></div>',
    ].join("");
    document.body.append(el);
    stage = el.querySelector(".emm-stage");
    detailEl = el.querySelector(".emm-detail");
    countEl = el.querySelector(".emm-count");
    el.querySelector(".emm-back").addEventListener("click", close);
    el.querySelector(".emm-reset").addEventListener("click", function () {
      hideDetail();
      try {
        window.EllenMemoryMap.reset();
      } catch (e) {}
    });
    sheet = el;
    return el;
  }

  function open() {
    var el = buildSheet();
    el.classList.add("on");
    /* 面板开着的时候，入口按钮会浮在它上面（它是插在 React 那个 tab 行里的），先藏起来 */
    document.querySelectorAll(".emm-entry").forEach(function (n) {
      n.style.display = "none";
    });
    loadAndRender();
  }

  function close() {
    if (!sheet) return;
    sheet.classList.remove("on");
    hideDetail();
    document.querySelectorAll(".emm-entry").forEach(function (n) {
      n.style.display = "";
    });
    try {
      window.EllenMemoryMap.unmount();
    } catch (e) {}
  }

  function showTip(html) {
    var old = stage.querySelector(".emm-empty");
    if (old) old.remove();
    var d = document.createElement("div");
    d.className = "emm-empty";
    d.innerHTML = html;
    stage.append(d);
  }

  /* 空面板不能是一块空地：铺几个待点亮的星位，再给一个能点的下一步 */
  function skeleton() {
    // 星位要避开中间那块文字区（x 28%~72% / y 36%~64%），否则会有个点正压在标题上
    var pts = [
      [8, 10], [26, 16], [48, 12], [70, 17], [90, 11],
      [15, 27], [38, 30], [62, 28], [84, 32],
      [6, 42], [92, 44], [10, 56], [90, 58],
      [14, 70], [36, 74], [60, 71], [84, 68],
      [8, 84], [30, 89], [54, 86], [78, 90], [92, 82],
    ];
    var s = '<div class="emm-skeleton">';
    for (var i = 0; i < pts.length; i++) {
      s += '<i style="left:' + pts[i][0] + "%;top:" + pts[i][1] + '%;"></i>';
    }
    return s + "</div>";
  }

  function emptyStateHtml() {
    return (
      skeleton() +
      "<h3>她还没攒下记忆</h3>" +
      "<p>等她把你的事记成一条条回忆，这里会亮起来。</p>" +
      '<button class="emm-cta" type="button">去聊两句</button>'
    );
  }

  /* 0 条记忆时这一排没有意义，整排藏掉，别让人点了没反应 */
  function setBarEnabled(on) {
    if (!sheet) return;
    sheet.classList.toggle("no-data", !on);
    var reset = sheet.querySelector(".emm-reset");
    if (reset) reset.disabled = !on;
    if (!on) hideDetail();
  }

  function currentMode() {
    try {
      var m = window.EllenMemoryMap && window.EllenMemoryMap.getMode
        ? window.EllenMemoryMap.getMode()
        : null;
      return m || "shell";
    } catch (e) {
      return "shell";
    }
  }

  function loadAndRender() {
    stage.querySelectorAll(".emm-empty").forEach(function (n) {
      n.remove();
    });
    countEl.textContent = "";
    setBarEnabled(false);
    showTip("<h3>正在翻她的记忆…</h3><p>第一次打开要读一下本地库。</p>");
    peekDb()
      .then(function (db) {
        if (!db) {
          showTip(
            "<h3>读不到记忆库</h3><p>这台设备还没建立长期记忆，或者库正被占用。过一会儿再打开试试。</p>"
          );
          return null;
        }
        var pid = activeProfileId();
        return readMemoryHeads(db, pid).then(function (heads) {
          return readValues(db, heads).then(function (values) {
            return heads
              .map(function (h, i) {
                var v = values[i];
                if (!v || typeof v !== "object") return null;
                return {
                  id: h.id,
                  title: v.title || "",
                  summary: v.summary || "",
                  kind: v.kind || "shared_event",
                  at: h.at || v.occurredAt || v.anchorAt || null,
                  confidence: typeof v.confidence === "number" ? v.confidence : undefined,
                  arousal: typeof v.arousal === "number" ? v.arousal : undefined,
                  baseStrength: typeof v.baseStrength === "number" ? v.baseStrength : undefined,
                };
              })
              .filter(function (m) {
                return m && m.title;
              });
          });
        });
      })
      .then(function (memories) {
        if (!memories) return;
        stage.querySelectorAll(".emm-empty").forEach(function (n) {
          n.remove();
        });
        if (!memories.length) {
          showTip(emptyStateHtml());
          var cta = stage.querySelector(".emm-cta");
          if (cta) {
            cta.addEventListener("click", function (ev) {
              ev.preventDefault();
              ev.stopPropagation();
              close();
            });
          }
          countEl.textContent = "0 条记忆";
          setBarEnabled(false);
          return;
        }
        setBarEnabled(true);
        var graph = buildGraph(memories, rootLabelCache);
        var layoutName = pickLayout();
        countEl.textContent = memories.length + " 条记忆，" + graph.meta.groups + " 组";
        var tipEl = sheet.querySelector(".emm-tip");
        if (tipEl) tipEl.hidden = false;
        /* 一条时间河得答得出「这是几号」：把首尾日期直接写在两端的刻度上，
           不然「最近/最早」只是两个方向词，看完还是不知道她记的是哪几个月。 */
        var railEls = sheet.querySelectorAll(".emm-rail span");
        if (railEls.length === 2) {
          var dts = memories
            .map(function (m) { return String(m.at || "").slice(5, 10); })
            .filter(Boolean)
            .sort();
          if (dts.length) {
            var dNew = dts[dts.length - 1].replace("-", "/");
            var dOld = dts[0].replace("-", "/");
            /* 记忆常常是同一天批量攒下的：两端写同一个日期等于什么也没说，
               那就把「更早」如实标出来，别假装有时间跨度。 */
            countEl.textContent =
              memories.length + " 条记忆 · " + graph.meta.groups + " 组 · " +
              (dOld === dNew ? dNew : dOld + "–" + dNew);
            railEls[0].textContent = "最近";
            railEls[1].textContent = "最早";
          }
        }
        sheet.dataset.mode = layoutName;
        var subEl = sheet.querySelector(".emm-sub");
        if (subEl) {
          /* 逐字跟着方向走：横屏写「往下走」会让人先去竖着划，划不动就以为坏了 */
          subEl.textContent =
            layoutName !== "portrait"
              ? "她攒下的事都在这一片，点一颗看看。"
              : "由新到旧往下走，一条河就是她记得的这些天。";
        }
        try {
          window.EllenMemoryMap.mount(stage, graph, {
            rootLabel: rootLabelCache,
            layout: layoutName,
            labelMax: 28,
            onFocus: function (n) {
              /* 手机是「点」，不是「转」：
                 点组 → 引擎自己就把别的压暗了（它本来就有聚焦语义），这里只负责讲清楚；
                 点记忆 → 底部卡片给标题、摘要、时间。 */
              if (!n) {
                hideDetail();
                return;
              }
              showDetail(n);
            },
          });
        } catch (e) {
          showTip(
            "<h3>星图没画出来</h3><p>" +
              String((e && e.message) || e) +
              "</p>"
          );
        }
        MAP.last = { memories: memories.length, groups: graph.meta.groups, nodes: graph.nodes.length };
        setBarEnabled(true);
      })
      .catch(function (e) {
        showTip("<h3>读记忆时出错</h3><p>" + String((e && e.message) || e) + "</p>");
      });
  }

  /* -------------------------------------------------------------- 入口 */
  /* 挂在「回忆 → 记忆」页的「她的过去 / 共同经历」那一行后面。
     React 会重渲染，所以用 MutationObserver 盯着，元素没了就补回去。 */

  function findTabRow() {
    var labels = ["她的过去", "共同经历"];
    var all = document.querySelectorAll("button,[role=button],div,span,a");
    var hit = null;
    for (var i = 0; i < all.length; i++) {
      var e = all[i];
      /* 星图自己的标签层里也有「共同经历」这种组名，会被当成 tab 行选中，
         结果「星图」按钮被插进 canvas 标签层里浮在面板上。先排掉自己人。 */
      if (e.closest(".emm-sheet,.memory-map-labels,.memory-map-shell")) continue;
      var t = (e.textContent || "").trim();
      if (labels.indexOf(t) < 0) continue;
      var r = e.getBoundingClientRect();
      if (r.width < 20 || r.height < 16) continue;
      if (r.top < 60 || r.top > window.innerHeight - 40) continue;
      if (!hit || r.top < hit.top) hit = { el: e, top: r.top, rect: r };
    }
    return hit;
  }

  function ensureEntry() {
    if (document.querySelector(".emm-entry")) return;
    var hit = findTabRow();
    if (!hit) return;
    var row = hit.el.parentElement;
    if (!row) return;
    if (row.querySelector(".emm-entry")) return;
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "emm-entry";
    btn.textContent = "星图";
    btn.style.marginLeft = "auto";
    btn.addEventListener("click", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      open();
    });
    var cs = window.getComputedStyle(row);
    if (cs.display === "flex" || cs.display === "inline-flex") {
      row.append(btn);
    } else {
      row.style.display = "flex";
      row.style.alignItems = "center";
      row.style.flexWrap = "wrap";
      row.style.gap = "clamp(5px,1.4vmin,7px)";
      row.append(btn);
    }
  }

  var mo = null;
  function watch() {
    if (mo) return;
    var pending = false;
    mo = new MutationObserver(function () {
      if (pending) return;
      pending = true;
      window.setTimeout(function () {
        pending = false;
        ensureEntry();
      }, 260);
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  function start() {
    watch();
    ensureEntry();
    window.setTimeout(ensureEntry, 1200);
    window.setTimeout(ensureEntry, 3000);
  }

  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });

  /* 两种河：竖屏从上往下流（时间在纵轴），横屏从左往右流（时间在横轴）。
     横屏塞竖河会缩成中间一条窄带、标签叠成一坨；横屏的长边是宽，时间就该顺着宽走。 */
  function pickLayout() {
    var w = window.innerWidth || 0;
    var h = window.innerHeight || 0;
    if (!w || !h) return "portrait";
    return h >= w * 1.15 ? "portrait" : "shell";
  }
  MAP.pickLayout = pickLayout;
  var resizeTimer = 0;
  window.addEventListener("resize", function () {
    if (!document.querySelector(".emm-sheet.on")) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      try {
        if (window.EllenMemoryMap && window.EllenMemoryMap.setLayout) {
          window.EllenMemoryMap.setLayout(pickLayout());
        }
      } catch (e) {}
    }, 280);
  });

  MAP.open = open;
  MAP.close = close;
  MAP.buildGraph = buildGraph;
  MAP.debugCounts = function () {
    return MAP.last || null;
  };
})();})();
/* ==== ELLEN-INJECT memory-map END ==== */
