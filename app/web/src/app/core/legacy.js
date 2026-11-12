// 一键迁移：扫手机上躺着的老版资料包（.ellenpack），直接读进来合并。
//
// 老版艾莲（cn.ellen.companion）的数据在它自己的 WebView localStorage 里，
// 别的应用按 Android 沙箱根本读不到；它唯一把资料放出来的途径就是导出 .ellenpack。
// 所以这里的「一键」是：扫共享存储里所有资料包（下载/文档/MediaStore），
// 列出来点一下就全导进来 —— 不用再开文件选择器一个个挑。
import { call, isNative } from './native/bridge.js';
import { extractSnapshot, importSnapshot, parseManifest, rebuildHeads } from './store/import.js';

/** 老包导出的文件名长这样：艾莲聊天资料-2026-11-12.ellenpack / ellen-2026-10-29.ellenpack。 */
const PACK_NAME = /\.ellenpacks?$/i;

export function isPack(name) {
  return PACK_NAME.test(String(name || ''));
}

export async function scanLegacy(treeUri) {
  if (!isNative()) return { items: [], oldInstalled: false, supported: false };
  const res = await call('EllenArchive', 'scanLegacy', treeUri ? { treeUri } : {});
  const items = (res.items || [])
    .map((it) => ({
      uri: String(it.uri || ''),
      name: String(it.name || ''),
      size: Number(it.size || 0),
      at: Number(it.at || 0),
      source: String(it.source || ''),
    }))
    .filter((it) => it.uri && isPack(it.name));
  items.sort((a, b) => b.at - a.at);
  return {
    items,
    oldInstalled: !!res.oldInstalled,
    treeUri: String(res.treeUri || ''),
    treeName: String(res.treeName || ''),
    supported: true,
  };
}

/** 让用户选一次文件夹（Download 之类）。Android 11+ 没这个授权就列不出别人的文件。 */
export async function pickLegacyFolder() {
  if (!isNative()) return { cancelled: true };
  return call('EllenArchive', 'pickLegacyFolder', {});
}

/** 只解析不落库，用来先给个数（多少条记录）。 */
export async function peekLegacy(uri) {
  const res = await call('EllenArchive', 'openPath', { uri });
  const parsed = parseManifest(res.manifestText);
  const { snapshot, content } = extractSnapshot(parsed);
  const preview = rebuildHeads(snapshot.records);
  return {
    heads: preview.heads.length,
    revisions: preview.revisions.length,
    kinds: countKinds(preview.heads),
    platform: (content && content.origin && content.origin.platform) || '',
    exportedAt: (content && content.exportedAt) || 0,
    snapshot,
  };
}

/** 读一个包并合并进库（不覆盖现有资料）。 */
export async function importLegacy(uri) {
  const peek = await peekLegacy(uri);
  if (!peek.heads) {
    const err = new Error('资料包里没有记录。');
    err.code = 'LEGACY_EMPTY';
    throw err;
  }
  const r = await importSnapshot(peek.snapshot, { merge: true });
  return { ...r, importedHeads: peek.heads };
}

/** 挨个导入，出错不中断；返回每份的结果，界面据此逐条更新。 */
export async function importAllLegacy(items, onStep) {
  const done = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (onStep) onStep({ index: i, total: items.length, item, stage: 'start' });
    try {
      const r = await importLegacy(item.uri);
      done.push({ item, ok: true, heads: r.heads, kinds: r.kinds });
      if (onStep) onStep({ index: i, total: items.length, item, stage: 'ok', result: r });
    } catch (err) {
      const message = (err && (err.code || err.message)) || String(err);
      done.push({ item, ok: false, error: message });
      if (onStep) onStep({ index: i, total: items.length, item, stage: 'fail', error: message });
    }
  }
  const imported = done.filter((d) => d.ok);
  const failed = done.filter((d) => !d.ok);
  return {
    done,
    imported: imported.length,
    failed: failed.length,
    heads: imported.reduce((sum, d) => sum + d.heads, 0),
  };
}

function countKinds(heads) {
  const out = {};
  for (const h of heads) out[h.kind || '?'] = (out[h.kind || '?'] || 0) + 1;
  return out;
}
