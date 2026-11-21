/**
 * 把「学作息」接到真实消息上：取最近的消息时间戳，算一次曲线（6 小时内不重算）。
 *
 * 单独一个文件而不是写在 main.js 里，是因为它要 await IndexedDB，
 * 而 main.js 的启动路径上不该多一个可能失败的 await。
 */

import { loadMessages } from './store/messages.js';
import { describeActivity, maybeRefreshActivity, readActivity } from './activity.js';

const SAMPLE_LIMIT = 400; // 400 条足够铺满 7 天的小时分布，再多只是白读

/**
 * 学一次作息。返回曲线数据（学不出来就返回现有的缓存）。
 * 任何异常都不抛 —— 学不到作息不该拖垮启动或聊天。
 */
export async function refreshActivityProfile() {
  try {
    const list = await loadMessages(null, SAMPLE_LIMIT);
    const rows = (Array.isArray(list) ? list : [])
      .map((m) => (m && Number.isFinite(m.createdAt) ? m.createdAt : null))
      .filter((v) => v !== null);
    const data = maybeRefreshActivity(rows);
    if (data && !data.cold) {
      console.info('[activity]', describeActivity(data));
    }
    return data;
  } catch (err) {
    console.warn('[activity] 学作息失败，沿用上次结果', err);
    return readActivity();
  }
}

/**
 * 启动时学一次，之后每次回到前台再看一眼（内部有 6 小时闸，不会每次真算）。
 * @returns {() => void} 退订函数
 */
export function watchActivityProfile() {
  refreshActivityProfile();
  const onVisible = () => {
    if (document.visibilityState === 'visible') refreshActivityProfile();
  };
  document.addEventListener('visibilitychange', onVisible);
  return () => document.removeEventListener('visibilitychange', onVisible);
}
