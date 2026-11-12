/**
 * 启动迁移入口（T1 批1）。
 *
 * 为什么单独放一个文件，而不塞进 messages.js：
 * 迁移是「启动时跑一次」的动作，和聊天读写不是一回事；分开以后 main.js 只依赖这一个模块，
 * 不会把整条消息读写链（records / db）顺手拉起来，启动顺序也好读。
 *
 * 迁移本身在 messages.js 的 migrateMessages() 里：它扫全部 kind='message' 的 head，
 * 只给缺字段的老数据补 type / recalled / quoteOf，补齐过的第二次跑 changed=0（幂等）。
 */

import { migrateMessages } from './messages.js';

/**
 * 启动时统一调它。目前只有消息要迁移，将来别的 kind 有结构变化时按同样口径往这里挂。
 * 任何异常都不要让 App 起不来：迁移是「补齐」，不是「修复」，失败了下次启动再补一次。
 *
 * @returns {Promise<{messages:number, scanned:number, changed:number}>}
 *          各 kind 补了多少条；跟着 messages 一起返回扫码总数，方便日志里对账
 */
export async function migrateAll() {
  const { scanned, changed } = await migrateMessages();
  return { messages: changed, scanned, changed };
}

export { migrateMessages, typeOfValue, upgradeMessageValue } from './messages.js';
