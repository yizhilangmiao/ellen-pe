// 本地语义向量：bge-small-zh-v1.5（int8 ONNX，22.8 MB）+ onnxruntime-web WASM。
//
// 为什么是 bge-small-zh-v1.5：
//   C-MTEB 中文检索这一档（24M 参数）里最强的开放模型，int8 量化 22.8 MB。
//   比之前被砍掉的 paraphrase-multilingual-MiniLM-L12-v2（69.6 MB 压缩 / 112.8 MB 解压）
//   小 3 倍、中文强一档 —— 砍掉它换概念词表是退步，现在换回来，而且是更好的那个。
//
// 为什么这次敢进召回主路径（recall.js 里的旧注释说「不上向量库」）：
//   旧结论的两个前提都不成立了：
//   ① 「每句多一次 embedding 请求」—— 模型跑在本机，一次前向 30~80 ms（手机单线程 WASM），
//      只在每条用户消息付一次，摊在 LLM 回复那几秒里等于零；
//   ② 「WebView 要背一份模型文件」—— 现在背了，22.8 MB + 11.1 MB wasm，换回真向量。
//   而且记忆侧的向量是**持久缓存**的（IndexedDB，int8，512 维 = 512 B/条），
//   新增记忆只编码新增那一条，不会每次查询重算全库。
//
// 降级是硬要求：模型缺失 / WASM 不支持 / 内存不够 / 任何异常 → status='off'，
// recall.js 自动退回字面+概念打分。宁可这轮只是字面匹配，也不能让「她突然想不起任何事」。
//
// 模型文件位置（vite public，构建时原样进 assets/public）：
//   models/bge-small-zh-v1.5/{config.json,tokenizer.json,tokenizer_config.json,onnx/model_int8.onnx}
//   ort/ort-wasm-simd-threaded.jsep.{wasm,mjs}

export const MODEL_ID = 'bge-small-zh-v1.5';
export const EMBED_DIM = 512;

// bge-zh 官方的检索指令。查询侧加、文档侧不加 —— 加上之后同义句的余弦明显拉开。
const QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：';

// 没写成最大长度：记忆一条 160 字以内，512 token 够；再长只是白算。
const MAX_TOKENS = 256;
// 一次喂几条。手机单线程 WASM 上 8 条 ≈ 300~600 ms，是「一次让出主线程」的上限。
const BATCH_SIZE = 8;

const DB_NAME = 'ellen.embed.v1';
const DB_VERSION = 1;
const STORE_VECTORS = 'vectors';

/** 运行状态机：idle → loading → ready / off。整个进程只加载一次。 */
const state = {
  status: 'idle', // idle | loading | ready | off
  error: null,
  loading: null, // Promise，避免并发重复初始化
  extractor: null,
  lastMs: 0, // 最近一次单句耗时（给体检页看）
  encoded: 0, // 本进程编码了多少条
};

export function embedStatus() {
  return {
    status: state.status,
    error: state.error,
    model: MODEL_ID,
    dim: EMBED_DIM,
    lastMs: Math.round(state.lastMs),
    encoded: state.encoded,
  };
}

/** 资源路径：public 下的文件在构建后位于站点根，用当前文档的 baseURI 拼绝对地址。 */
function assetUrl(rel) {
  try {
    return new URL(rel, document.baseURI).href;
  } catch {
    return rel;
  }
}

// ── IndexedDB：向量持久缓存 ──────────────────────────────────────
//
// 独立库，不碰 store/db.js 的记忆库：召回是只读旁路，不该把向量写进容易被备份/导出的记忆库；
// 向量随时可以重算，丢了只是慢一次，不是数据损失。
let dbPromise = null;

function openEmbedDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_VECTORS)) {
        const store = db.createObjectStore(STORE_VECTORS, { keyPath: 'k' });
        store.createIndex('model', 'model');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

/** 缓存键：模型 + 记忆/日记的 revisionId。换模型自动全部失效，不会新旧混算。 */
export function vectorKey(kind, revisionId) {
  return `${MODEL_ID}:${kind}:${revisionId}`;
}

/**
 * 读一批向量。
 * @param {string[]} keys
 * @returns {Promise<Map<string, Float32Array>>} 缺的键不在 Map 里
 */
export async function loadVectors(keys) {
  const out = new Map();
  if (!keys || !keys.length) return out;
  const db = await openEmbedDb();
  if (!db) return out;
  return new Promise((resolve) => {
    let tx;
    try {
      tx = db.transaction([STORE_VECTORS], 'readonly');
    } catch {
      resolve(out);
      return;
    }
    const store = tx.objectStore(STORE_VECTORS);
    for (const k of keys) {
      const req = store.get(k);
      req.onsuccess = () => {
        const row = req.result;
        if (row && row.q) out.set(k, dequantize(row.q, row.dim || EMBED_DIM));
      };
    }
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => resolve(out);
    tx.onabort = () => resolve(out);
  });
}

/**
 * 写一批向量。int8 量化后存：512 维 = 512 B/条，5000 条 ≈ 2.5 MB。
 * 量化误差在余弦上约 1e-3，对召回排序没有影响（实测见 _临时/recall-bench 报告）。
 */
export async function saveVectors(entries) {
  if (!entries || !entries.length) return false;
  const db = await openEmbedDb();
  if (!db) return false;
  return new Promise((resolve) => {
    let tx;
    try {
      tx = db.transaction([STORE_VECTORS], 'readwrite');
    } catch {
      resolve(false);
      return;
    }
    const store = tx.objectStore(STORE_VECTORS);
    const at = Date.now();
    for (const [k, vec] of entries) {
      if (!vec) continue;
      store.put({ k, model: MODEL_ID, dim: vec.length, q: quantize(vec), at });
    }
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
    tx.onabort = () => resolve(false);
  });
}

function quantize(vec) {
  const out = new Int8Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    const v = Math.max(-1, Math.min(1, vec[i]));
    out[i] = Math.round(v * 127);
  }
  return out;
}

function dequantize(q, dim) {
  const out = new Float32Array(dim);
  const n = Math.min(dim, q.length);
  for (let i = 0; i < n; i++) out[i] = q[i] / 127;
  return out;
}

/** 清空向量缓存（换模型 / 体检页「重建索引」用）。 */
export async function clearVectors() {
  const db = await openEmbedDb();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction([STORE_VECTORS], 'readwrite');
      tx.objectStore(STORE_VECTORS).clear();
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

// ── 模型加载 ────────────────────────────────────────────────────

/**
 * 确保模型可用。并发调用共享同一个 Promise。
 * @returns {Promise<boolean>} 可用返回 true；任何失败返回 false 并把状态置 off
 */
export function ensureEmbedder() {
  if (state.status === 'ready') return Promise.resolve(true);
  if (state.status === 'off') return Promise.resolve(false);
  if (state.loading) return state.loading;

  state.status = 'loading';
  state.loading = (async () => {
    const t0 = Date.now();
    try {
      if (typeof WebAssembly === 'undefined') throw new Error('当前环境没有 WebAssembly');

      // 动态 import：模型/运行时出问题只影响这一个 chunk，主界面照常起来。
      const mod = await import('@huggingface/transformers');
      const env = mod.env;

      // 一切资源都在本地：不许走 CDN（离线、无网、被墙都得出得来）。
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      env.localModelPath = assetUrl('models/');
      env.useBrowserCache = true;

      if (env.backends && env.backends.onnx && env.backends.onnx.wasm) {
        env.backends.onnx.wasm.wasmPaths = assetUrl('ort/');
        // Capacitor WebView 没有 COOP/COEP 头 → SharedArrayBuffer 不可用 → 强制单线程，
        // 否则 ort 会尝试起 worker 然后卡死在初始化。
        env.backends.onnx.wasm.numThreads = 1;
        env.backends.onnx.wasm.proxy = false;
      }

      const extractor = await mod.pipeline('feature-extraction', MODEL_ID, {
        dtype: 'int8',
        device: 'wasm',
      });

      state.extractor = extractor;
      state.status = 'ready';
      state.error = null;
      console.info(`[embed] 模型就绪，用时 ${Date.now() - t0} ms`);
      return true;
    } catch (err) {
      state.status = 'off';
      state.error = String((err && err.message) || err);
      state.extractor = null;
      console.warn('[embed] 模型不可用，语义召回退回字面+概念：', state.error);
      return false;
    }
  })();

  return state.loading;
}

/** 主线程别被一批编码堵死：让出一帧再继续。 */
function yieldToUi() {
  return new Promise((r) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => r());
    else setTimeout(r, 0);
  });
}

/**
 * 编码一批文本。
 * @param {string[]} texts
 * @param {{query?: boolean}} [opts] query=true 时加 bge 的检索指令前缀
 * @returns {Promise<Array<Float32Array|null>>} 与输入等长，失败位置是 null
 */
export async function embedMany(texts, { query = false } = {}) {
  const list = (texts || []).map((t) => String(t || ''));
  if (!list.length) return [];
  const ok = await ensureEmbedder();
  if (!ok) return list.map(() => null);

  // 空文本不喂模型（喂了会得到一个「空句向量」，反而和谁都有点像）。
  const idx = [];
  const inputs = [];
  for (let i = 0; i < list.length; i++) {
    const t = list[i].trim();
    if (!t) continue;
    idx.push(i);
    inputs.push(query ? QUERY_PREFIX + t : t);
  }
  const out = new Array(list.length).fill(null);
  if (!inputs.length) return out;

  for (let s = 0; s < inputs.length; s += BATCH_SIZE) {
    const chunk = inputs.slice(s, s + BATCH_SIZE);
    const t0 = Date.now();
    let tensor;
    try {
      tensor = await state.extractor(chunk, {
        pooling: 'cls', // bge 用 CLS，不是 mean
        normalize: true, // 出来直接是单位向量，余弦 = 点积
        truncation: true,
        max_length: MAX_TOKENS,
      });
    } catch (err) {
      console.warn('[embed] 编码失败：', err);
      if (s === 0) {
        // 第一次就炸，基本是运行时坏了：整体关掉，别每条消息都重试一遍
        state.status = 'off';
        state.error = String((err && err.message) || err);
      }
      continue;
    }
    const data = tensor.data;
    const dim = (tensor.dims && tensor.dims[tensor.dims.length - 1]) || EMBED_DIM;
    for (let i = 0; i < chunk.length; i++) {
      const vec = new Float32Array(dim);
      for (let d = 0; d < dim; d++) vec[d] = data[i * dim + d];
      out[idx[s + i]] = vec;
    }
    state.lastMs = chunk.length ? (Date.now() - t0) / chunk.length : 0;
    state.encoded += chunk.length;
    if (s + BATCH_SIZE < inputs.length) await yieldToUi();
  }
  return out;
}

/** 单条便捷入口。 */
export async function embedOne(text, opts) {
  const [v] = await embedMany([text], opts);
  return v || null;
}

/** 余弦。两边都归一化过时它就是点积；这里仍按通用公式写，防调用方喂了未归一化的向量。 */
export function cosine(a, b) {
  if (!a || !b) return 0;
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na <= 0 || nb <= 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 模型预热：应用启动时调一次，别等用户说完第一句话才加载。失败静默。 */
export function warmup() {
  if (state.status !== 'idle') return;
  // 让首屏先渲染完再啃 22.8 MB 的模型
  setTimeout(() => {
    ensureEmbedder().catch(() => {});
  }, 2500);
}
