package cn.ellen.companion2.proactive

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters

/**
 * 闹钟响了之后的真正执行体。
 *
 * 为什么不直接在 BroadcastReceiver 里联网：onReceive 只有 10 秒窗口，
 * 一次模型请求经常要 3~20 秒；放进 WorkManager 才能拿到正常执行时限，
 * 而且失败/被杀之后系统会补跑一次。
 */
class EllenProactiveWorker(context: Context, params: WorkerParameters) : Worker(context, params) {

    override fun doWork(): Result {
        val context = applicationContext
        if (!EllenProactiveStore.enabled(context)) return Result.success()

        try {
            EllenProactiveRunner.run(context, false)
        } catch (e: Exception) {
            EllenProactiveStore.markRun(
                context,
                "failed",
                "WORKER · ${e.javaClass.simpleName}: ${e.message.orEmpty()}".take(180),
            )
        }
        // 无论成败都排下一次：失败一次不该把整条链停掉
        EllenProactiveScheduler.scheduleNext(context)
        return Result.success()
    }

    companion object {
        const val NAME = "ellen-proactive-tick"
    }
}
