// adb 辅助：把 WebView 的 devtools socket 转发成本地 TCP
//
// 为什么需要：手机版每次重启 APP，pid 会变，socket 名跟着变
// （@webview_devtools_remote_<pid>），手敲的 forward 立刻就失效。
// 所以 run.mjs 每次连之前都重新查 pid + 重发 forward。
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const CANDIDATES = [
  'E:\\ailian\\工具\\android-sdk\\platform-tools\\adb.exe',
  'C:\\Program Files\\Netease\\MuMu\\nx_device\\12.0\\shell\\adb.exe',
];

export function findAdb(explicit) {
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`--adb 指的路径不存在: ${explicit}`);
    return explicit;
  }
  for (const p of CANDIDATES) if (existsSync(p)) return p;
  return 'adb'; // 交给 PATH
}

/**
 * 重新转发一遍，返回当前 pid。
 * @param {{adb:string, serial:string, port:number, pkg?:string}} o
 */
export function forwardWebView({ adb, serial, port, pkg = 'cn.ellen.companion2' }) {
  const run = (args) => {
    const out = execFileSync(adb, ['-s', serial, ...args], { encoding: 'utf8', timeout: 20000 });
    return String(out || '').trim();
  };

  // 先确保设备是连着的（MuMu 的 127.0.0.1:<port> 断线后要重连）
  try {
    run(['connect', serial]);
  } catch {
    /* 已经连着时 connect 也可能返回非零，忽略 */
  }

  const pid = run(['shell', `pidof ${pkg}`]);
  if (!pid) throw new Error(`设备 ${serial} 上没在跑 ${pkg} —— 先把艾莲打开`);

  // forward 覆盖同端口的老映射（老映射指向已死的 pid，连上去会 fetch failed）
  run(['forward', `tcp:${port}`, `localabstract:webview_devtools_remote_${pid}`]);
  return { pid: Number(pid.split(/\s+/)[0]), port, serial };
}
