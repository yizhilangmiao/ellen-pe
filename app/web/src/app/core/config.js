// 模型配置的读写。落盘走原生 EllenSecureConfig（AndroidKeyStore + AES/GCM 加密），
// 明文只在内存里出现，不写 localStorage（老包也是这么做的）。
//
// 老包换了包名后无法解密旧 vault（KeyStore 别名 + noBackupFilesDir 都绑定包名），
// 所以两个包并存期间配置要各自重填一次，或走导出通道明文交接。
//
// 服务地址：旧包把火山方舟写死在原生里，换一家 key 必然 401。
// 新壳原生已放开成"任意 https 的 OpenAI 兼容端点"，这里给出平台预设，
// 用户选平台 → 地址自动填好，只输 key 与模型名。
import { call } from './native/bridge.js';

const SCOPE = 'model';

/**
 * 平台预设。endpoint 里的 {model} 不参与拼接 —— 地址与模型名分开存，
 * 因为火山方舟的地址里不含模型名（模型走 body），DeepSeek 也一样。
 */
export const PLATFORMS = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    endpoint: 'https://api.deepseek.com/chat/completions',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    keyHint: '在 DeepSeek 开放平台的「API keys」页建一枚，形如 sk- 开头的 32 位。',
  },
  {
    id: 'ark',
    label: '火山方舟',
    endpoint: 'https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions',
    models: [],
    keyHint: '在方舟控制台的「API Key 管理」建一枚，形如 8-4-4-4-12 的 UUID，不带 sk- 前缀。',
  },
  {
    id: 'custom',
    label: '自定义',
    endpoint: '',
    models: [],
    keyHint: '填任意 OpenAI 兼容的 /chat/completions 地址，必须 https。',
  },
];

const DEFAULT_PLATFORM = 'deepseek';

const DEFAULT_CONFIG = {
  platform: DEFAULT_PLATFORM,
  endpoint: PLATFORMS[0].endpoint,
  apiKey: '',
  model: '',
  thinking: 'default',
};

export function platformOf(id) {
  return PLATFORMS.find((p) => p.id === id) || PLATFORMS[0];
}

export async function loadModelConfig() {
  try {
    const res = await call('EllenSecureConfig', 'read', { scope: SCOPE });
    const raw = res && typeof res.value === 'string' ? res.value : '';
    if (!raw) return { ...DEFAULT_CONFIG };
    const parsed = JSON.parse(raw);
    const merged = { ...DEFAULT_CONFIG, ...parsed };
    // 老配置没有 platform 字段时，按地址反推一个，免得界面显示空白
    if (!merged.platform) {
      const hit = PLATFORMS.find((p) => p.endpoint && p.endpoint === merged.endpoint);
      merged.platform = hit ? hit.id : 'custom';
    }
    return merged;
  } catch (err) {
    // 读不到就当没配（不弹错，聊天页会显示"未配置聊天模型"）
    console.warn('[config] 读取模型配置失败', err);
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveModelConfig(cfg) {
  const merged = { ...DEFAULT_CONFIG, ...cfg };
  await call('EllenSecureConfig', 'write', { scope: SCOPE, value: JSON.stringify(merged) });
  return merged;
}

export async function clearModelConfig() {
  await call('EllenSecureConfig', 'remove', { scope: SCOPE });
}

/** 一份配置是否够用来聊天。 */
export function isUsable(cfg) {
  return !!(cfg && cfg.apiKey && cfg.model && cfg.endpoint);
}

export { DEFAULT_CONFIG, DEFAULT_PLATFORM, SCOPE };
