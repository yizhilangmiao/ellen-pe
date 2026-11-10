package cn.ellen.companion2.proactive

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager

/**
 * 闹钟与系统事件入口。只做两件事：补排下一次、把「跑一次」丢给 WorkManager。
 *
 * 注意 intent.action 可能是 null（系统开机广播有时不带 action），
 * 上一版直接 intent.action.equals(...) 会 NPE 把整个广播吞掉。
 */
class EllenProactiveReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action ?: return
        val accepted = action == EllenProactiveScheduler.ACTION_TICK ||
            action == Intent.ACTION_BOOT_COMPLETED ||
            action == Intent.ACTION_MY_PACKAGE_REPLACED
        if (!accepted) return

        val app = context.applicationContext
        // 非 TICK（开机/装完新包）时闹钟是空的，先按当前间隔补排一次
        if (action != EllenProactiveScheduler.ACTION_TICK) {
            EllenProactiveScheduler.scheduleNext(app)
        }
        if (!EllenProactiveStore.enabled(app)) return

        val request = OneTimeWorkRequestBuilder<EllenProactiveWorker>().build()
        try {
            WorkManager.getInstance(app).enqueueUniqueWork(
                EllenProactiveWorker.NAME,
                ExistingWorkPolicy.REPLACE,
                request,
            )
        } catch (e: Exception) {
            // WorkManager 没初始化（极少见）就直接在广播里试一次
            Thread {
                try {
                    EllenProactiveRunner.run(app, false)
                } catch (_: Exception) {
                    /* 已经尽力 */
                }
            }.start()
        }
    }
}
