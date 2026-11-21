/**
 * 主题偏好：亮 / 暗 / 跟系统 + 预设配色 + 自己调色（排期 4a / 4b）。
 *
 * 这里只管「选什么」和「怎么算」，不碰 DOM —— 挂 data-theme、刷 CSS 变量、
 * 同步原生状态栏都在 main.js 的 applyTheme / applyColors 里做。好处是这个文件
 * 在 node 里能直接跑，不用模拟 document。
 *
 * 存储：`ellen.theme.v1`。
 *   - 老格式（4a）存的是 `'dark' | 'light' | 'system'` 纯字符串；
 *   - 新格式（4b）存 `{"mode":"dark","preset":"warm","colors":{...}}`。
 *   读取时两种都认，读到老格式就当叠在当前预设上的一次迁移，不需要单独的迁移代码。
 * 更老的 key `ellen-ui-theme` 只存 dark/light，也在 readThemeConfig 里搬一次。
 */

export const THEME_KEY = 'ellen.theme.v1';
export const LEGACY_THEME_KEY = 'ellen-ui-theme';

/** 三档：跟系统排第一，因为多数人想要的就是它。 */
export const THEME_MODES = ['system', 'light', 'dark'];

/** 老版本只有这两档，迁移时用它白名单。 */
const LEGACY_MODES = ['light', 'dark'];

/**
 * 可自定义的七个色位。
 *
 * key 是给界面和存储用的短名，cssVar 是真正落到根元素上的变量名。
 * 只挑这七个：手机版 167 处硬编码 hex 里其余的都是阴影 / 半透明层，
 * 改了反而容易脏，不如让它们跟着这七个主色走。
 */
export const COLOR_SLOTS = [
  { key: 'bg', cssVar: '--el-bg', label: '背景' },
  { key: 'card', cssVar: '--el-surface', label: '卡片' },
  { key: 'text', cssVar: '--el-text', label: '正文' },
  { key: 'sub', cssVar: '--el-muted', label: '次要文字' },
  { key: 'accent', cssVar: '--el-pink', label: '强调色' },
  { key: 'bubble', cssVar: '--el-self', label: '我的气泡' },
  { key: 'border', cssVar: '--el-line', label: '分隔线' },
];

/**
 * 四套预设。
 *
 * default 的 colors 是 null：不覆盖任何一个变量，直接吃 CSS 里那两套
 * （暗色默认 + light 覆盖）。这样以后调 tokens.css 的默认配色，选「默认」的人
 * 自动跟着变——预设不该把默认值抄一份进来，抄了就会跟 CSS 漂移。
 */
export const THEME_PRESETS = [
  { id: 'default', label: '默认', colors: null },
  {
    id: 'warm',
    label: '暖夜',
    colors: {
      bg: '#1c1714',
      card: '#28211c',
      text: '#f6ece4',
      sub: '#bda99c',
      accent: '#e8b48d',
      bubble: '#f0d9c4',
      border: '#ffffff14',
    },
  },
  {
    id: 'cool',
    label: '冷白',
    colors: {
      bg: '#f4f6f9',
      card: '#ffffff',
      text: '#1d2430',
      sub: '#6b7686',
      accent: '#8aa6c8',
      bubble: '#dfe8f5',
      border: '#1d24301f',
    },
  },
  {
    id: 'paper',
    label: '纸感',
    colors: {
      bg: '#f3efe6',
      card: '#fbf8f1',
      text: '#3a342c',
      sub: '#7c7266',
      accent: '#b98a5e',
      bubble: '#efe4d2',
      border: '#3a342c1f',
    },
  },
];

export const PRESET_IDS = THEME_PRESETS.map((p) => p.id);

/**
 * 手改过某一格之后 preset 记成 'custom'。
 *
 * 它不是一个可选预设（不在 THEME_PRESETS 里），只是一个状态：界面据此显示
 * 「自定义」，也据此知道这套色不跟着预设更新走。
 */
export const CUSTOM_PRESET = 'custom';

function isValidPreset(id) {
  return PRESET_IDS.includes(id) || id === CUSTOM_PRESET;
}

/** 取预设定义；认不出来的一律退回 default。 */
export function findPreset(id) {
  return THEME_PRESETS.find((p) => p.id === id) || THEME_PRESETS[0];
}

function isColor(value) {
  return typeof value === 'string' && /^#[0-9a-f]{3,8}$/i.test(value.trim());
}

/**
 * 把任意输入洗成合法的 colors 对象。
 *
 * 只保留认识的七个 key、只留合法 hex。多存的、脏的、undefined 一律丢掉——
 * 存储层是唯一不可信的地方（用户可能手改 localStorage、老版本可能写过别的形状）。
 */
export function normalizeColors(input) {
  if (!input || typeof input !== 'object') return null;
  const out = {};
  let any = false;
  for (const slot of COLOR_SLOTS) {
    const v = input[slot.key];
    if (isColor(v)) {
      out[slot.key] = v.trim().toLowerCase();
      any = true;
    }
  }
  return any ? out : null;
}

function defaultConfig() {
  return { mode: 'dark', preset: 'default', colors: null, colorsSource: null, roleId: '' };
}

/**
 * 读完整配置。一定是 `{ mode, preset, colors }` 这个形状。
 *
 * 兼容三件事：
 *   1. 老 key `ellen-ui-theme`（只有 dark/light）→ 搬成 mode；
 *   2. 4a 的纯字符串格式 → 当 mode，preset 仍是 default；
 *   3. 4b 的对象格式 → 逐字段洗一遍。
 * 隐私模式下 localStorage 抛错，全部退回默认，别让启动流程挂在这。
 */
export function readThemeConfig() {
  let raw = null;
  let legacy = null;
  try {
    raw = localStorage.getItem(THEME_KEY);
    legacy = localStorage.getItem(LEGACY_THEME_KEY);
  } catch {
    return defaultConfig();
  }

  if (raw) {
    // 4a 的纯字符串
    if (THEME_MODES.includes(raw)) {
      return { ...defaultConfig(), mode: raw };
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        const mode = THEME_MODES.includes(parsed.mode) ? parsed.mode : 'dark';
        const preset = isValidPreset(parsed.preset) ? parsed.preset : 'default';
        const colors = normalizeColors(parsed.colors);
        // 老数据没有 colorsSource：那时候只有一种来源，就是用户自己挑的
        const colorsSource = colors
          ? (parsed.colorsSource === 'role' ? 'role' : 'manual')
          : null;
        return {
          mode,
          preset,
          colors,
          colorsSource,
          roleId: typeof parsed.roleId === 'string' ? parsed.roleId : '',
        };
      }
    } catch {
      /* 落下去走默认 */
    }
  }

  if (legacy && LEGACY_MODES.includes(legacy)) {
    // 老用户第一次升上来：把他原来的亮/暗搬成新值，不给他突然换脸
    return { ...defaultConfig(), mode: legacy };
  }

  return defaultConfig();
}

/** 写完整配置。不可写时静默失败——下次启动退回默认，不影响当前这次观感。 */
export function writeThemeConfig(config) {
  const mode = THEME_MODES.includes(config && config.mode) ? config.mode : 'dark';
  const preset = isValidPreset(config && config.preset) ? config.preset : 'default';
  const colors = normalizeColors(config && config.colors);
  if (preset !== 'default' && preset !== CUSTOM_PRESET && !colors) {
    // 选了预设却没给色：不写，否则下次启动会以为用户选了「默认」却带着预设名
    throw new Error(`预设 ${preset} 缺少颜色`);
  }
  const colorsSource = colors ? (config.colorsSource === 'role' ? 'role' : 'manual') : null;
  const roleId = typeof (config && config.roleId) === 'string' ? config.roleId : '';
  try {
    localStorage.setItem(THEME_KEY, JSON.stringify({ mode, preset, colors, colorsSource, roleId }));
  } catch {
    /* 忽略 */
  }
}

/**
 * 切角色时套上角色包自带的那套色。
 *
 * 优先级（排期 9 定的）：角色包 < 全局自定义 < 用户当场手改。
 * 所以只要 colorsSource === 'manual'（用户自己动过取色器），这里一个字都不改——
 * 换角色不该悄悄把他的配色抹掉。要拿回角色色，让他点「恢复默认配色」。
 *
 * roleColors 为 null/不合法时表示这个角色没带配色：把之前角色留下的色清掉。
 */
export function applyRoleTheme(roleId, roleColors) {
  const cur = readThemeConfig();
  const id = typeof roleId === 'string' ? roleId : '';
  if (cur.colorsSource === 'manual') {
    // 只记下「现在是谁」，颜色留给他自己挑的
    writeThemeConfig({ ...cur, roleId: id });
    return readThemeConfig();
  }
  const colors = normalizeColors(roleColors);
  if (!colors) {
    writeThemeConfig({ ...cur, colors: null, preset: 'default', colorsSource: null, roleId: id });
    return readThemeConfig();
  }
  writeThemeConfig({ mode: cur.mode, preset: CUSTOM_PRESET, colors, colorsSource: 'role', roleId: id });
  return readThemeConfig();
}

/** 兼容 4a：只读档位。 */
export function readTheme() {
  return readThemeConfig().mode;
}

/** 兼容 4a：只写档位，其余字段保留。 */
export function writeTheme(mode) {
  if (!THEME_MODES.includes(mode)) throw new Error(`未知的主题档位: ${mode}`);
  const cur = readThemeConfig();
  writeThemeConfig({ ...cur, mode });
}

/**
 * 把档位算成实际生效的 dark|light。
 *
 * prefersLight 由调用方传（浏览器里是 matchMedia('(prefers-color-scheme: light)').matches），
 * 不在这里读 matchMedia，是为了这个函数能纯函数化测试。
 */
export function resolveTheme(mode, prefersLight) {
  if (mode === 'system') return prefersLight ? 'light' : 'dark';
  if (mode === 'light' || mode === 'dark') return mode;
  return 'dark';
}

/** 这一档是不是「跟系统」——界面要给个提示说它会被系统设置覆盖。 */
export function isSystemMode(mode) {
  return mode === 'system';
}

/* ============================================================
 * 对比度保护（WCAG）
 *
 * 没有这一层，这个功能就是个 bug 制造机：把字调成跟背景一个色，
 * 用户第二天来找你说「艾莲变哑巴了」。所以只要给色，就先算对比度。
 * ============================================================ */

/** #rgb / #rrggbb / #rrggbbaa → [r, g, b]（0–255）。认不出来返回 null。 */
export function parseColor(value) {
  if (typeof value !== 'string') return null;
  let s = value.trim().replace(/^#/, '');
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  if (s.length !== 6 && s.length !== 8) return null;
  const r = parseInt(s.slice(0, 2), 16);
  const g = parseInt(s.slice(2, 4), 16);
  const b = parseInt(s.slice(4, 6), 16);
  if ([r, g, b].some((n) => Number.isNaN(n))) return null;
  return [r, g, b];
}

/** 相对亮度（WCAG 2.1）。 */
export function luminance(value) {
  const rgb = parseColor(value);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((n) => {
    const c = n / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 对比度比值（1–21）。任一色认不出来返回 null。 */
export function contrastRatio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  if (la === null || lb === null) return null;
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

function toHex(rgb) {
  return `#${rgb.map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * 把一个前景色往黑或白推，直到跟背景的对比度达标。
 *
 * 为什么是推向黑/白而不是调亮度：色相保持不变，用户仍认得「这是我调的那个颜色」，
 * 只是更亮或更暗。推到 0 或 255 还达不到（几乎不可能，纯黑对纯白是 21:1）就返回纯黑/白。
 */
export function pushForContrast(fg, bg, minRatio = 4.5) {
  const base = parseColor(fg);
  const bgLum = luminance(bg);
  if (!base || bgLum === null) return fg;
  const towardsWhite = bgLum < 0.5;
  let cur = base.slice();
  for (let i = 0; i < 24; i += 1) {
    const ratio = contrastRatio(toHex(cur), bg);
    if (ratio !== null && ratio >= minRatio) return toHex(cur);
    // 每步走 12% 的剩余距离：24 步足够走完，又不会一步跳到纯白丢掉色相
    cur = cur.map((n) => (towardsWhite ? n + (255 - n) * 0.12 : n * 0.88));
  }
  return towardsWhite ? '#ffffff' : '#000000';
}

/**
 * 给一组自定义色做体检，返回 `{ colors, issues }`。
 *
 * 只查真实起作用的组合：正文/背景、次要文字/背景、正文/卡片。
 * 气泡里的字不吃 `--el-text`（它有自己的 `--el-self-ink`），所以不在这里查，
 * 由 themeVars 按气泡明暗自动配一个——那是推导，不是「用户配错了」。
 * 不达标就顺手修（调前景，不动背景——背景是用户最在意的那个）。
 * `issues` 里每项带 key / ratio / fixed，界面可以拿去提示「已帮你调亮了一点」。
 */
export function ensureReadable(colors, minRatio = 4.5) {
  if (!colors) return { colors: null, issues: [] };
  const out = { ...colors };
  const issues = [];
  const checks = [
    { key: 'text', against: 'bg', ratio: minRatio },
    { key: 'sub', against: 'bg', ratio: 3 },
    { key: 'text', against: 'card', ratio: minRatio },
  ];
  if (!out.card) out.card = out.bg;
  for (const check of checks) {
    const fg = out[check.key];
    const bg = out[check.against];
    if (!fg || !bg) continue;
    const before = contrastRatio(fg, bg);
    if (before === null || before >= check.ratio) continue;
    const fixed = pushForContrast(fg, bg, check.ratio);
    out[check.key] = fixed;
    issues.push({
      key: check.key,
      against: check.against,
      ratio: Math.round(before * 100) / 100,
      need: check.ratio,
      fixed,
    });
  }
  return { colors: out, issues };
}

/** 设置页那套变量的映射表（正牌色位 → 设置页变量），themeVars 与 ALL_THEME_VARS 共用。 */
/**
 * 绝区零皮肤那套 --z-*。
 *
 * zz-tokens.css 里有一张「别名桥」把 --el-* 指向 --z-*；但组件一旦挪到
 * --z-* 上就只认 z 了。所以自定义配色必须两边都写——只写 el，聊天页和底栏
 * 有一半不动，用户会以为「选了冷白没生效」。
 *
 * 不碰 --z-paper*：那是气泡纸族，专属亮底，跟主色是两条线，跟过去会串味。
 */
const Z_MIRROR = [
  ['bg', ['--z-bg', '--z-sunken']],
  ['card', ['--z-card', '--z-panel']],
  ['text', ['--z-ink']],
  ['sub', ['--z-ink-2', '--z-ink-3']],
  ['accent', ['--z-pink']],
  ['bubble', ['--z-self']],
  ['border', ['--z-line-hair']],
];

/**
 * +<input type="color"> 只吃 #rrggbb。
 *
 * 主题里 --el-self、--el-line 是 8 位带 alpha 的（#191c20f2 / #ffffff14），
 * 直接塞进取色器会被当成非法值吞成纯黑——用户看到「分隔线是黑的」，其实它是半透明白。
 */
export function toHex6(value) {
  const hex = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^#[0-9a-f]{3,8}$/.test(hex)) return null;
  if (hex.length === 4) return '#' + hex.slice(1).split('').map((c) => c + c).join('');
  return hex.slice(0, 7);
}
const SETTINGS_MIRROR = [
  ['bg', '--el-settings-page'],
  ['card', '--el-settings-surface'],
  ['card', '--el-settings-raised'],
  ['text', '--el-settings-ink'],
  ['sub', '--el-settings-muted'],
  ['accent', '--el-settings-accent'],
  ['accent', '--el-settings-primary'],
  ['border', '--el-settings-line'],
];

/**
 * 自定义色可能碰到的全部变量名。
 *
 * 换预设 / 恢复默认时要逐个 removeProperty——不先清，上一次设的变量会一直挂在
 * 根元素的内联样式上，切到「默认」也回不去（内联优先级高于 CSS 规则）。
 */
export const ALL_THEME_VARS = [
  ...COLOR_SLOTS.map((s) => s.cssVar),
  '--el-self-ink',
  ...Z_MIRROR.flatMap(([, list]) => list),
  ...SETTINGS_MIRROR.map(([, cssVar]) => cssVar),
];

/**
 * 算出要落到根元素上的 CSS 变量。
 *
 * 除了七个正牌色位，还顺手推几个「跟着走」的变量：
 *   - `--el-self-ink`：气泡里的字。气泡被调成深色时自动换成亮字，否则字会糊在气泡里。
 *   - 设置页那套 `--el-settings-*`：设置页是独立配色，不跟着走的话，
 *     选了「冷白」进设置还是暗紫，整页像两张皮。
 * 预设与手改走同一条路（colors 就是最终值），所以「预设 + 手改某一格」自然成立。
 */
export function themeVars(colors) {
  const clean = normalizeColors(colors);
  if (!clean) return {};
  const vars = {};
  for (const slot of COLOR_SLOTS) {
    const v = clean[slot.key];
    if (v) vars[slot.cssVar] = v;
  }
  // 气泡字跟着气泡底走：底色暗就给亮字，底色亮就给深字
  if (clean.bubble) {
    const lum = luminance(clean.bubble);
    if (lum !== null) {
      vars['--el-self-ink'] = pushForContrast(lum < 0.5 ? '#ffffff' : '#000000', clean.bubble, 4.5);
    }
  }
  // 绝区零皮肤只认 --z-*：不写这一份，切了预设一半界面不动
  for (const [key, list] of Z_MIRROR) {
    if (!clean[key]) continue;
    for (const cssVar of list) vars[cssVar] = clean[key];
  }
  // 设置页跟着主色走（只推关键几个，其余留给它自己的 dark/light 覆盖）
  for (const [key, cssVar] of SETTINGS_MIRROR) {
    if (clean[key]) vars[cssVar] = clean[key];
  }
  return vars;
}
