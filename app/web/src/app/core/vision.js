// 视觉（「她看得见我」）：配置、能不能看图、送帧节流、拼多模态请求。
//
// 为什么这些全在一个文件里：它们共用同一个判断「这份配置到底能不能吃图」。
// 拆成两个文件，设置页与通话页就会各自再判一次，判不一致的表现很恶心
// ——「设置里说能用，通话里一帧都不发」，或者反过来，一直发图把 token 烧光。
//
// 三条硬规矩：
// 1) **不写死任何一家**。模型名只做特征匹配（vision / vl / gpt-4o / claude / flash-4.1 …），
//    认不出来就老实说「当前模型不吃图」，不替用户猜。
// 2) **静止不送帧**。这是这个功能的命根子：老大原话「静止时几乎不花 token」。
//    所以节流是纯函数、可单测，不藏在视图的 setInterval 里。
// 3) 配置里带 apiKey，落盘走 IDB meta（任务书指定 ellen.vision.v1）。
//    想跟聊天 key 一样进 KeyStore 加密，得给原生白名单加一个 scope ——
//    见报告里的说明，改这里两处即可（readRaw / writeRaw）。
// —— 配置读写 ——
// 这一节是纯逻辑，node 能直接跑（不 import 原生层）。原生与 IDB 都在函数里动态加载，
// 这样单测只要 import 本文件就够，不会因为缺 Capacitor 或者没有 IndexedDB 而挂。

/** 存储键（IDB meta）。任务书指定，别改。 */
export const VISION_KEY = 'ellen.vision.v1';

/** 长边上限：768 是任务书指标。压到这么大，模型还看得清人，一张图也不过几十 KB。 */
export const FRAME_MAX_SIDE = 768;

/** 长边可调范围的上限。超过 768 只会让每帧变大，任务书的指标就是 768。 */
export const FRAME_MAX_SIDE_HINT = 1280;

/** 两帧之间最短间隔：1fps 上限。900ms 而不是 1000，是给定时器漂移留余量。 */
export const MIN_GAP_MS = 900;

/** 画面完全没变时多久补一帧。不补的话长时间不看会像断了；补也不贵（一帧/20 秒）。 */
export const STILL_REFRESH_MS = 20_000;

/** 灰度均值差低于这个数就当没变化（配合 frameDiffScore 用的兜底阈值）。 */
export const FRAME_DIFF_MIN = 0.02;

/**
 * 相机这条路的止损线：开了 30 分钟还一帧都没拿到，就认输、改用「拍照给她看」。
 * 为什么是 30 分钟：老大给的台阶就是这个数，够走完一次「插上试、发现不行、换个办法」；
 * 再久就是白耗电，不如早点退到相机之外那条已经能跑的相册通路。
 */
export const CAMERA_GIVE_UP_MS = 30 * 60 * 1000;

/** 取一帧最多等多久。超过这个当「相机没通」，而不是干等。 */
export const CAMERA_PROBE_MS = 900;

/**
 * 相机降级判定。相机帧要原生插件（EllenCamera），本 JS 版本只到「拿得到帧就送」为止，
 * 所以这里把「什么时候放弃相机」写成纯函数，UI/报告都能引用同一个数。
 *
 * @returns {{fallback:boolean, reason:'unsupported'|'streaming'|'idle'|'timeout'|'waiting', waited?:number}}
 */
export function cameraFallback({ startedAt = 0, now = Date.now(), frames = 0, supported = true } = {}) {
  if (!supported) return { fallback: true, reason: 'unsupported' };
  if (frames > 0) return { fallback: false, reason: 'streaming' };
  if (!startedAt) return { fallback: false, reason: 'idle' };
  const waited = Math.max(0, now - startedAt);
  if (waited >= CAMERA_GIVE_UP_MS) return { fallback: true, reason: 'timeout', waited };
  return { fallback: false, reason: 'waiting', waited };
}

/**
 * 「这个模型可能吃图」的特征词。
 * 只往里加**能分辨**的片段：加 "flash" 会把 glm-4-flash 这种纯文本模型也放进来，
 * 加 "4" 更糟。所以 flash 只认带版本号的写法（flash-4.1）。
 */
export const VISION_HINTS = [
  'vision',
  'gpt-4o',
  'gpt-4.1',
  'gpt-5',
  'claude',
  'gemini',
  'qwen-vl',
  'qwen2-vl',
  'qwen2.5-vl',
  'qwen3-vl',
  'flash-4.1',
  'flash4.1',
  '4.1-flash',
  'glm-4v',
  'glm-4.1v',
  'internvl',
  'llava',
  'pixtral',
  'minicpm-v',
  'yi-vl',
  'doubao-vision',
  'vision-preview',
  'step-1v',
];

/** 独立成词才算的短标记（"vl" 太短，靠 includes 会误伤别的名字）。 */
const VL_TOKENS = new Set(['vl', 'vlm', 'mm', 'omni']);

/** 明确不吃图的名字：命中就直接判否，省得被别的规则误放行。 */
const NOT_VISION_MODELS = ['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder', 'moonshot-v1-8k', 'moonshot-v1-32k'];

export const DEFAULT_VISION = {
  enabled: false,
  model: '',
  baseUrl: '',
  apiKey: '',
  maxSide: FRAME_MAX_SIDE,
  quality: 0.7,
  minGapMs: MIN_GAP_MS,
  stillMs: STILL_REFRESH_MS,
  forceVision: false,
};

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function clampFloat(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 把任意来源的配置收成稳定形状（坏值一律回落，不抛错）。 */
export function normalizeVisionConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: src.enabled === true,
    model: String(src.model || '').trim(),
    baseUrl: String(src.baseUrl || '').trim(),
    apiKey: String(src.apiKey || '').trim(),
    maxSide: clampInt(src.maxSide, 320, FRAME_MAX_SIDE_HINT, FRAME_MAX_SIDE),
    quality: clampFloat(src.quality, 0.3, 0.95, DEFAULT_VISION.quality),
    // 间隔不能小于 300ms：再快就不是「省 token」而是拿钱烧接口了
    minGapMs: clampInt(src.minGapMs, 300, 10_000, MIN_GAP_MS),
    stillMs: clampInt(src.stillMs, 1000, 300_000, STILL_REFRESH_MS),
    forceVision: src.forceVision === true,
  };
}

/**
 * 这个模型名看起来吃不吃图。
 * 判据顺序：强制开关 → 明确不吃图的黑名单 → 特征词 → 独立短标记。
 * @param {{model?:string, forceVision?:boolean}|null} cfg
 */
export function supportsVision(cfg) {
  if (!cfg) return false;
  if (cfg.forceVision === true) return true;
  const model = String(cfg.model || '').trim().toLowerCase();
  if (!model) return false;
  if (NOT_VISION_MODELS.some((bad) => model.includes(bad))) return false;
  if (VISION_HINTS.some((hint) => model.includes(hint))) return true;
  // qwen-vl-max 里的 vl 已被上面的 hint 命中；这里兜的是 "xx/vl" 这种只写短标记的
  const tokens = model.split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.some((t) => VL_TOKENS.has(t));
}

/**
 * 设置页与通话页共用的结论：到底能不能看图、用哪个模型。
 * 模型名留空 = 回落到聊天模型（任务书要求），所以这里必须拿到聊天配置。
 * @returns {{enabled:boolean, usable:boolean, model:string, reason:string, hint:string}}
 *          reason: off | no-chat | no-model | no-key | not-vision | ok
 */
export function visionPlan({ vision, chat } = {}) {
  const v = normalizeVisionConfig(vision);
  const c = chat || {};
  const model = v.model || String(c.model || '');
  const base = {
    enabled: v.enabled,
    usable: false,
    model,
    reason: 'ok',
    hint: '',
  };
  if (!v.enabled) return { ...base, reason: 'off', hint: '视觉还没开。开了她才能在通话里看见你。' };
  if (!model) return { ...base, reason: 'no-model', hint: '没填视觉模型，也没配聊天模型。' };
  if (!v.model) {
    // 回落聊天模型：这时 key/地址都跟着聊天配置走
    if (!c.apiKey || !c.endpoint) return { ...base, reason: 'no-chat', hint: '聊天模型还没配好，视觉没处回落。' };
    if (!supportsVision({ model })) {
      return { ...base, reason: 'not-vision', hint: `当前模型不吃图（${model}）。填一个能看图的模型。` };
    }
    return { ...base, usable: true, hint: `用聊天模型看图（${model}）。` };
  }
  if (!supportsVision(v) && !v.forceVision) {
    return { ...base, reason: 'not-vision', hint: `这个名字看着不吃图（${model}）。确认能吃图就打开「强制按视觉模型用」。` };
  }
  const apiKey = v.apiKey || c.apiKey;
  const endpoint = v.baseUrl || c.endpoint;
  if (!apiKey || !endpoint) return { ...base, reason: 'no-key', hint: '视觉模型缺少地址或钥匙。' };
  return { ...base, usable: true, hint: `用视觉模型看图（${model}）。` };
}

/** 真正发请求时的配置：视觉那栏填了就用它，没填就整份沿用聊天配置。 */
export function resolveVisionTarget({ vision, chat } = {}) {
  const v = normalizeVisionConfig(vision);
  const c = chat || {};
  const model = v.model || String(c.model || '');
  return {
    endpoint: v.baseUrl || String(c.endpoint || ''),
    apiKey: v.apiKey || String(c.apiKey || ''),
    model,
    platform: v.model ? 'custom' : c.platform,
    thinking: 'default',
    maxSide: v.maxSide,
    quality: v.quality,
  };
}

/**
 * 这一帧要不要送。
 * @param {object} o
 * @param {string} [o.prevHash]  上一帧的指纹（frameHash 的结果）
 * @param {string} [o.hash]      这一帧的指纹；空 = 没取到画面
 * @param {number} o.now         当前时间（ms）
 * @param {number} [o.lastSentAt] 上一次真的送出去的时间；0/缺省 = 还没送过
 * @param {number} [o.minGapMs]
 * @param {number} [o.stillMs]
 * @returns {{send:boolean, reason:string}}
 *          reason: no-frame | first | too-soon | still | still-heartbeat | changed
 */
export function shouldSendFrame({ prevHash, hash, now, lastSentAt = 0, minGapMs = MIN_GAP_MS, stillMs = STILL_REFRESH_MS } = {}) {
  const h = String(hash || '');
  if (!h) return { send: false, reason: 'no-frame' };
  const at = Number(now) || 0;
  const last = Number(lastSentAt) || 0;
  const gap = last ? at - last : Infinity;
  const min = Number(minGapMs) > 0 ? Number(minGapMs) : MIN_GAP_MS;
  const still = Number(stillMs) > 0 ? Number(stillMs) : STILL_REFRESH_MS;

  if (!last) return { send: true, reason: 'first' };
  if (gap < min) return { send: false, reason: 'too-soon' };
  const same = prevHash !== undefined && String(prevHash || '') === h;
  if (same) {
    // 画面没动：等到 stillMs 再补一帧。既省 token，又不至于让她觉得人走了。
    return gap >= still ? { send: true, reason: 'still-heartbeat' } : { send: false, reason: 'still' };
  }
  return { send: true, reason: 'changed' };
}

/** 两帧灰度的均值差，归一到 0–1。用于「指纹之外」的粗筛（例如缩略图不够稳时）。 */
export function frameDiffScore(a, b) {
  const mean = (arr) => {
    if (!arr || !arr.length) return 0;
    let sum = 0;
    for (let i = 0; i < arr.length; i++) sum += Number(arr[i]) || 0;
    return sum / arr.length;
  };
  if (!a || !b || !a.length || !b.length) return 0;
  return Math.min(1, Math.abs(mean(a) - mean(b)) / 255);
}

/**
 * 帧指纹：FNV-1a 扫一遍采样字节。
 * 为什么不用 crypto.subtle：它是异步的，而节流判断每秒都要做；而且 WebView 里
 * 不在安全上下文时 crypto.subtle 可能不存在。FNV 够用（撞了两帧也只是少送一帧）。
 * @param {Uint8Array|number[]} bytes 建议给缩小后的灰度图或 JPEG 头几十字节
 */
export function frameHash(bytes) {
  if (!bytes || !bytes.length) return '';
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= Number(bytes[i]) & 0xff;
    // 乘 16777619 用移位拼，避免 32 位溢出后变成浮点
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 缩到长边不超过 maxSide（纯算术，原生/画布都按它做）。 */
export function downscalePlan({ width, height, maxSide = FRAME_MAX_SIDE } = {}) {
  const w = Math.max(0, Math.round(Number(width) || 0));
  const h = Math.max(0, Math.round(Number(height) || 0));
  const cap = Math.max(1, Math.round(Number(maxSide) || FRAME_MAX_SIDE));
  if (!w || !h) return { width: cap, height: cap, scale: 0 };
  const scale = Math.min(1, cap / Math.max(w, h));
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
    scale,
  };
}

/**
 * 拼 OpenAI 兼容的多模态 content 数组。
 * 文字放前面、图放后面：多数端点两种顺序都认，但先说「你看看这个」再给图，
 * 模型的回答更贴人话（实测把图放前面容易变成纯描述）。
 */
export function buildVisionParts({ jpegBase64, text = '', mime = 'image/jpeg', detail = 'low' } = {}) {
  const parts = [];
  const body = String(text || '').trim();
  if (body) parts.push({ type: 'text', text: body });
  const b64 = String(jpegBase64 || '');
  if (!b64) return parts;
  // 已经是 data URL 就直接用，别拼成 data:image/jpeg;base64,data:image/...
  const url = b64.startsWith('data:') ? b64 : `data:${mime};base64,${b64}`;
  parts.push({ type: 'image_url', image_url: { url, ...(detail ? { detail } : {}) } });
  return parts;
}

// —— 存取（IDB meta）——
// 读写都失败不抛：视觉是可选功能，存不下就当没开，别把设置页搞崩。

async function readRaw() {
  try {
    const { getMeta } = await import('./store/records.js');
    const value = await getMeta(VISION_KEY, null);
    if (!value) return null;
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch (err) {
    console.warn('[vision] 读视觉配置失败', err);
    return null;
  }
}

async function writeRaw(cfg) {
  try {
    const { putMeta } = await import('./store/records.js');
    await putMeta(VISION_KEY, cfg);
    return true;
  } catch (err) {
    console.warn('[vision] 写视觉配置失败', err);
    return false;
  }
}

/** @returns {Promise<ReturnType<typeof normalizeVisionConfig>>} 读不到就是默认（关闭）。 */
export async function readVisionConfig() {
  const raw = await readRaw();
  return normalizeVisionConfig(raw);
}

/** 增量写：只覆盖传进来的字段，其余保留。 */
export async function writeVisionConfig(patch) {
  const cur = await readVisionConfig();
  const next = normalizeVisionConfig({ ...cur, ...(patch || {}) });
  await writeRaw(next);
  return next;
}

export async function clearVisionConfig() {
  const next = { ...DEFAULT_VISION };
  await writeRaw(next);
  return next;
}

/**
 * 真正问她「你看见什么」：走一次性非流式请求（和记忆抽取同一条通路）。
 * @param {{config:object, imageBase64:string, text?:string, maxTokens?:number}} opts
 *        config 传 resolveVisionTarget() 的结果
 * @returns {Promise<string>} 她的话
 */
export async function describeImage({ config, imageBase64, text = '', maxTokens = 320 } = {}) {
  const target = config || {};
  if (!target.endpoint) throw Object.assign(new Error('没有配置视觉服务地址'), { code: 'NO_VISION_CONFIG' });
  const parts = buildVisionParts({ jpegBase64: imageBase64, text });
  if (!parts.some((p) => p.type === 'image_url')) {
    throw Object.assign(new Error('没有拿到画面'), { code: 'NO_FRAME' });
  }
  const { ask } = await import('./chat/oneshot.js');
  return ask({
    config: target,
    messages: [{ role: 'user', content: parts }],
    maxTokens,
  });
}
