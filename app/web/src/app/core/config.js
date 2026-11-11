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
    title: 'DeepSeek（深度求索）',
    tagline: '最省事的一家，注册就送额度，聊起来够用。',
    endpoint: 'https://api.deepseek.com/chat/completions',
    signupUrl: 'https://platform.deepseek.com/api_keys',
    signupSteps: ['浏览器打开这个网址，用手机号注册', '在「API keys」页面点「创建 API key」', '复制出来那串 sk- 开头的，粘到第二步'],
    keyShape: 'sk- 开头的一长串',
    models: [
      { id: 'deepseek-chat', note: '推荐 · 日常聊天够用，最便宜' },
      { id: 'deepseek-reasoner', note: '会先想一会儿，回答更细，也贵一点' },
    ],
  },
  {
    id: 'siliconflow',
    label: '硅基流动',
    title: '硅基流动 SiliconFlow',
    tagline: '国内直连、有免费额度，模型多，也能跑语音识别。',
    endpoint: 'https://api.siliconflow.cn/v1/chat/completions',
    signupUrl: 'https://cloud.siliconflow.cn/account/ak',
    signupSteps: ['浏览器打开这个网址，注册并实名', '在「API 密钥」里新建一枚', '复制那串 sk- 开头的'],
    keyShape: 'sk- 开头的一长串',
    models: [
      { id: 'Qwen/Qwen2.5-7B-Instruct', note: '推荐 · 便宜、够用' },
      { id: 'deepseek-ai/DeepSeek-V3', note: '更聪明，价格高一些' },
    ],
  },
  {
    id: 'dashscope',
    label: '阿里百炼',
    title: '阿里云百炼（通义千问）',
    tagline: '阿里云账号直接开，新用户有免费额度。',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    signupUrl: 'https://bailian.console.aliyun.com/',
    signupSteps: ['浏览器打开百炼控制台并登录阿里云账号', '在「API-KEY 管理」里创建一枚', '复制 sk- 开头的那串'],
    keyShape: 'sk- 开头的一长串',
    models: [
      { id: 'qwen-plus', note: '推荐 · 中文顺、速度稳' },
      { id: 'qwen-turbo', note: '更便宜，稍笨一点' },
    ],
  },
  {
    id: 'moonshot',
    label: 'Kimi',
    title: '月之暗面 Kimi',
    tagline: '长文本见长，中文聊天自然。',
    endpoint: 'https://api.moonshot.cn/v1/chat/completions',
    signupUrl: 'https://platform.moonshot.cn/console/api-keys',
    signupSteps: ['浏览器打开 Kimi 开放平台并登录', '在「API Key 管理」里新建', '复制 sk- 开头的那串'],
    keyShape: 'sk- 开头的一长串',
    models: [
      { id: 'moonshot-v1-8k', note: '推荐 · 便宜' },
      { id: 'moonshot-v1-32k', note: '能记住更长的上下文' },
    ],
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    title: '智谱 GLM',
    tagline: 'glm-4-flash 有免费档，适合先试试。',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    signupUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    signupSteps: ['浏览器打开智谱开放平台并登录', '在「API Keys」里新建', '复制那串（有的带点号，照原样粘）'],
    keyShape: '一串字符，可能带一个点',
    models: [
      { id: 'glm-4-flash', note: '推荐 · 有免费档' },
      { id: 'glm-4-plus', note: '更好，按量付费' },
    ],
  },
  {
    id: 'ark',
    label: '火山方舟',
    title: '火山方舟（豆包）',
    tagline: '字节的，需要先在控制台建「推理接入点」。',
    endpoint: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    signupUrl: 'https://console.volcengine.com/ark',
    signupSteps: ['浏览器打开方舟控制台并开通', '在「API Key 管理」建一枚（是一串 UUID，不带 sk-）', '再去「在线推理」建一个接入点，把接入点 ID 当模型名填'],
    keyShape: '一串 UUID，形如 xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
    models: [],
  },
  {
    id: 'custom',
    label: '我自己有',
    title: '我自己有地址',
    tagline: '任何 OpenAI 兼容的 /chat/completions 地址都行，必须是 https。',
    endpoint: '',
    signupUrl: '',
    signupSteps: [],
    keyShape: '看服务商给的说明',
    models: [],
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
