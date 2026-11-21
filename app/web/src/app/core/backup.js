// 自动备份（原 BackupGroups 引擎的新壳版本）。
//
// 旧包 `EllenBackupStore` + `BackupGroups`（82 KB smali）做四件事：按指纹判「有没有变化」、
// 挑一个备份组（chats/memories/recollections/characters）、把整组写成 `.ellenpack` 落进用户选的
// 文件夹、按天数与份数轮换。新壳沿用它的**可见契约**（`backupCall` / `chooseBackupDirectory` /
// `cancelBackup` + `BACKUP_*` 错误码），但内部策略故意简化：
//
//   * 一次备份 = 一个整包，不再按 chats/memories/recollections/characters 拆四份。
//     理由：我们导出的容器本来就是「一份 manifest + 一堆附件」，四类拆包会把同一批附件复制四遍，
//     而附件目前是 metadata-only（不带字节），拆开只是白占地方。
//   * 「有没有变化」用 heads/revisions 计数 + 最近一次改动时间当指纹，不读全表。
//   * 轮换只按份数（默认留 3 份），间隔天数只决定「该不该跑」。
//
// 目录选择走原生 SAF（`ACTION_OPEN_DOCUMENT_TREE` + 持久化授权），所以选一次之后不用再选。
import { call } from './native/bridge.js';
import { exportBatches } from './store/export.js';
import { count } from './store/db.js';

const PLUGIN = 'EllenArchive';
const PREF_KEY = 'ellen.backup.v1';
const DAY = 86400000;

export const DEFAULT_CONFIG = { enabled: false, intervalDays: 7, retainGroups: 3 };

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function localPrefs() {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return { ...DEFAULT_CONFIG, fingerprint: '', lastRunAt: 0, lastTotalBytes: 0, lastParts: 0 };
    const parsed = JSON.parse(raw);
    return {
      enabled: !!parsed.enabled,
      intervalDays: Number(parsed.intervalDays) || DEFAULT_CONFIG.intervalDays,
      retainGroups: Number(parsed.retainGroups) || DEFAULT_CONFIG.retainGroups,
      fingerprint: typeof parsed.fingerprint === 'string' ? parsed.fingerprint : '',
      lastRunAt: Number(parsed.lastRunAt) || 0,
      // 分片备份时原生 prefs 的 lastBytes 只是最后一片的大小，整轮的字节数得自己记
      lastTotalBytes: Number(parsed.lastTotalBytes) || 0,
      lastParts: Number(parsed.lastParts) || 0,
    };
  } catch {
    return { ...DEFAULT_CONFIG, fingerprint: '', lastRunAt: 0, lastTotalBytes: 0, lastParts: 0 };
  }
}

function localWrite(patch) {
  const next = { ...localPrefs(), ...patch };
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(next));
  } catch {
    /* 隐私模式下写不进去，跑一次算一次 */
  }
  return next;
}

async function nativeState() {
  try {
    return await call(PLUGIN, 'backupCall', { method: 'state', value: {} });
  } catch (err) {
    if (err && err.code === 'BACKUP_UNAVAILABLE') {
      return { supported: false, enabled: false, directory: '', directoryName: '', groups: [] };
    }
    throw err;
  }
}

/** 前端看到的完整状态：原生存的 + 本地这份（间隔/保留/指纹）。 */
export async function state() {
  const [native, local] = await Promise.all([nativeState(), Promise.resolve(localPrefs())]);
  // 重装 App 会清掉 SharedPreferences，但文件夹里的备份还在：
  // 这种情况下从最新一份备份的 at 反推「上次备份」，否则界面会写「还没备份过 · 已有 2」自相矛盾。
  const groups = Array.isArray(native.groups) ? native.groups.slice() : [];
  let lastSuccessAt = Number(native.lastSuccessAt) || 0;
  let lastName = native.lastName || '';
  let lastBytes = Number(native.lastBytes) || 0;
  if (!lastSuccessAt && groups.length) {
    const newest = groups.reduce((a, b) => (Number(b.at) > Number(a.at) ? b : a), groups[0]);
    lastSuccessAt = Number(newest.at) || 0;
    lastName = newest.name || '';
    // 原生 groups 的键是 bytes（不是 sizeBytes），写错这里会让「上次备份」永远显示 0.00 MB
    lastBytes = Number(newest.bytes) || 0;
  }
  return {
    supported: native.supported !== false,
    enabled: typeof native.enabled === 'boolean' ? native.enabled : local.enabled,
    intervalDays: Number(native.intervalDays) || local.intervalDays,
    retainGroups: Number(native.retainGroups) || local.retainGroups,
    directory: native.directory || '',
    directoryName: native.directoryName || '',
    nextAt: Number(native.nextAt) || 0,
    lastSuccessAt,
    lastName,
    lastBytes,
    lastError: native.lastError || '',
    writing: !!native.writing,
    groups,
    fingerprint: local.fingerprint,
    lastRunAt: local.lastRunAt,
    // 这一轮备份一共几个包、一共多少字节（普通用户就是 1 个包）
    lastParts: local.lastParts || (groups.length ? 1 : 0),
    lastTotalBytes: local.lastTotalBytes || lastBytes,
  };
}

/** 选文件夹（SAF，一次性授权）。 */
export async function chooseDirectory() {
  const res = await call(PLUGIN, 'chooseBackupDirectory', {});
  if (res && res.cancelled) return null;
  return res;
}

export async function configure(patch) {
  const value = {};
  if (patch.enabled !== undefined) value.enabled = !!patch.enabled;
  if (patch.intervalDays !== undefined) value.intervalDays = Math.max(1, Math.min(90, Math.round(patch.intervalDays)));
  if (patch.retainGroups !== undefined) value.retainGroups = Math.max(1, Math.min(10, Math.round(patch.retainGroups)));
  if (patch.enabled === true) {
    // 本地也记一份，启动时不必等原生
    localWrite({ enabled: true, intervalDays: value.intervalDays, retainGroups: value.retainGroups });
  } else {
    localWrite({ ...value });
  }
  await call(PLUGIN, 'backupCall', { method: 'configure', value });
  return state();
}

/** 指纹：只读计数，不读 value（2 万条消息也只花几毫秒）。 */
export async function fingerprint() {
  const [heads, revisions] = await Promise.all([count('data-heads'), count('data-revisions')]);
  return `${heads}:${revisions}`;
}

/** 现在该不该备份（给界面显示与启动时判断）。 */
/** 有改动时最短间隔：不到日子也至少隔这么久才补备份。 */
const CHANGE_GAP_MS = 12 * 3600 * 1000;

export async function due(now = Date.now()) {
  const [st, fp] = await Promise.all([state(), fingerprint()]);
  if (!st.supported) return { due: false, reason: 'unsupported' };
  if (!st.enabled) return { due: false, reason: 'off' };
  if (!st.directory) return { due: false, reason: 'noDirectory' };
  if (st.writing) return { due: false, reason: 'busy' };
  const changed = fp !== st.fingerprint;
  const timeUp = !st.nextAt || now >= st.nextAt;
  if (timeUp) return { due: true, reason: changed ? 'changed' : 'schedule' };
  if (!changed) return { due: false, reason: 'unchanged' };
  // 有改动但还没到日子：至少要隔 CHANGE_GAP_MS 再补一份，
  // 否则每聊一句就写一个 7 MB 的包，手机顶不住（也是为什么不是「一改就备」）。
  const sinceLast = st.lastRunAt || st.lastSuccessAt || 0;
  if (now - sinceLast < CHANGE_GAP_MS) return { due: false, reason: 'notDue' };
  return { due: true, reason: 'changed' };
}

/** 把一片的统计并进总数（分片后 UI 要的是「整轮」的数，不是最后一片的）。 */
function accumulate(total, part) {
  if (!part) return total;
  total.heads += part.heads || 0;
  total.revisions += part.revisions || 0;
  total.records += part.records || 0;
  total.attachments += part.attachments || 0;
  total.attachmentsBytes += part.attachmentsBytes || 0;
  total.attachmentsSkipped += part.attachmentsSkipped || 0;
  total.manifestBytes += part.manifestBytes || 0;
  total.profiles = Math.max(total.profiles, part.profiles || 0);
  if (part.loreCardId) total.loreCardId = part.loreCardId;
  if (part.kinds) {
    for (const [k, n] of Object.entries(part.kinds)) total.kinds[k] = (total.kinds[k] || 0) + n;
  }
  return total;
}

/**
 * 跑一次备份。force=true 时不看开关/间隔（设置页「立刻备份一份」用）。
 *
 * 一次备份可能写出好几个包：库大到一片装不下时会自动分片（见 export.js 的
 * exportBatches）。普通用户文本少，永远只有一片，行为与以前一致。
 * @returns {{ ok: boolean, skipped?: string, group?: object, groups?: object[], parts?: number, pruned?: string[], stats?: object, ms?: number }}
 */
export async function run({ force = false, onProgress } = {}) {
  const started = Date.now();
  const st = await state();
  if (!st.supported) return { ok: false, skipped: 'unsupported' };
  if (!force && !st.enabled) return { ok: false, skipped: 'off' };
  if (!st.directory) return { ok: false, skipped: 'noDirectory' };
  if (st.writing) return { ok: false, skipped: 'busy' };

  if (onProgress) onProgress({ stage: 'collect', index: 0 });
  const groups = [];
  const pruned = [];
  const stats = accumulate(
    { heads: 0, revisions: 0, profiles: 0, records: 0, kinds: {}, attachments: 0, attachmentsBytes: 0, attachmentsSkipped: 0, manifestBytes: 0, loreCardId: '' },
    null,
  );
  let index = 0;
  let lastGroup = null;

  // 一片一包：生成器每次只持有当前这片记录，所以必须写完这一片再取下一片，
  // 不能先收集完再写（那就等于把整库攒回内存，白改了）。
  for await (const batch of exportBatches()) {
    index += 1;
    accumulate(stats, batch.stats);
    if (onProgress) onProgress({ stage: 'begin', index, bytes: batch.stats.manifestBytes });
    const begun = await call(PLUGIN, 'backupCall', {
      method: 'begin',
      // part 让原生把片号写进文件名（同一秒开两片会撞名，撞了就轮换看不见）；
      // deferPrune 让每片提交时先别轮换，等整轮写完统一 prune。
      value: { manifestText: batch.manifestText, part: index, deferPrune: true },
    });
    const handle = begun && begun.handle;
    if (!handle) throw fail('BACKUP_WRITE_FAILED', '备份没开起来。');
    try {
      if (onProgress) onProgress({ stage: 'commit', index });
      const done = await call(PLUGIN, 'backupCall', { method: 'commit', value: { handle } });
      if (done && done.group) {
        groups.push(done.group);
        lastGroup = done.group;
      }
      if (done && Array.isArray(done.pruned)) pruned.push(...done.pruned);
    } catch (err) {
      try {
        await call(PLUGIN, 'backupCall', { method: 'abort', value: { handle } });
      } catch {
        /* 半截文件由原生 deleteDocument 处理，这里失败也不该盖住原始错误 */
      }
      throw err;
    }
  }

  // 整轮写完了才轮换：keepAtLeast 明确告诉原生「这一轮的包一个都别删」，
  // 否则片数一超过「保留几份」，第 4 片提交就会把第 1 片当最老的备份删掉。
  try {
    const pr = await call(PLUGIN, 'backupCall', { method: 'prune', value: { keepAtLeast: groups.length } });
    if (pr && Array.isArray(pr.pruned)) pruned.push(...pr.pruned);
  } catch {
    /* 轮换失败不该把整次备份判失败：包已经落盘了 */
  }

  localWrite({
    fingerprint: await fingerprint(),
    lastRunAt: Date.now(),
    lastTotalBytes: stats.manifestBytes,
    lastParts: groups.length,
  });
  return {
    ok: true,
    group: lastGroup,
    groups,
    parts: groups.length,
    pruned,
    stats,
    ms: Date.now() - started,
  };
}

/** 启动时/回前台时调：该备就备，别再问人。 */
export async function autoRun() {
  const st = await state();
  if (!st.enabled || !st.directory) return { ok: false, skipped: st.enabled ? 'noDirectory' : 'off' };
  const why = await due();
  if (!why.due) return { ok: false, skipped: why.reason };
  return run();
}

/** 从备份文件夹挑一份回来（导入用）：返回文件 URI 列表。 */
export async function listGroups() {
  const st = await state();
  return st.groups;
}

export { DAY };
