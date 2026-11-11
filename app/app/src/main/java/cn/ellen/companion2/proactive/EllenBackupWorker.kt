package cn.ellen.companion2.proactive

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import cn.ellen.companion2.MainActivity
import cn.ellen.companion2.R
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * 后台定时备份的**触发器**。只做一件事：到点了发一条提醒。
 *
 * 为什么不在这里真备份：备份包的内容（manifest JSON）是 web 层用 IndexedDB 现算的，
 * 原生没有数据源；而后台进程起不了 WebView（旧包 EllenAutonomyJobService 就是死在
 * 后台藏 WebView 上，见 _verify/M5-主动消息.md 第一节）。所以后台只负责「叫醒用户」，
 * 用户点通知进来、App 回到前台时 web 的 autoRun() 会真写一份。
 *
 * 排期方式复刻主动消息那条链：WorkManager 单实例 + 首次 delay（不用 AlarmManager，
 * 因为 WorkManager 的延迟在重启后仍然有效，7 天这种长间隔不必自己补排开机广播）。
 */
class EllenBackupWorker(context: Context, params: WorkerParameters) : Worker(context, params) {

    override fun doWork(): Result {
        val context = applicationContext
        val state = readState(context)
        if (!state.optBoolean("enabled") || state.optString("directory").isBlank()) {
            cancel(context)
            return Result.success()
        }

        val now = System.currentTimeMillis()
        val at = resolveAt(state, now)
        // 系统可能提前把带 delay 的活拉起来（doze 窗口、补跑），没到点就只重排
        if (now < at - MIN_DELAY_MS) {
            scheduleNext(context)
            return Result.success()
        }

        // 同一个到点时刻只提醒一次：用户这次不理，不该每 12 小时再吵一遍
        val prefs = prefs(context)
        if (prefs.getLong(KEY_NOTIFIED, 0L) != at) {
            notifyDue(context)
            prefs.edit().putLong(KEY_NOTIFIED, at).apply()
        }
        // nextAt 故意不动：web 的 due() 靠它判「该备了」，动了就永远不备
        schedule(context, now + RETRY_MS)
        return Result.success()
    }

    private fun channel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "备份提醒", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "到日子了提醒你打开艾莲备份"
                setSound(null, null)
            }
        )
    }

    private fun notifyDue(context: Context) {
        channel(context)
        val open = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("ellen.backup", "due")
        }
        val pi = PendingIntent.getActivity(
            context,
            NOTIFICATION_ID,
            open,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val text = "该备份了，打开艾莲我自动存一份"
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_ellen_notify)
            .setColor(0xFFE4B8CD.toInt())
            .setContentTitle("艾莲")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .build()
        try {
            NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, notification)
        } catch (_: SecurityException) {
            /* 没给通知权限：下次开 App 的 autoRun() 照样会备 */
        }
    }

    companion object {
        /** unique work 名字（和主动消息的 ellen-proactive-tick 分开）。 */
        const val NAME = "ellen-backup-tick"

        /** 与 EllenArchivePlugin 共用的 SharedPreferences（备份状态唯一事实源）。 */
        private const val PREFS = "ellen-backup-v1"
        private const val KEY_STATE = "state"
        /** 已经为哪个 nextAt 提醒过（同一个到点时刻只吵一次）。 */
        private const val KEY_NOTIFIED = "notifiedFor"

        private const val DAY = 86_400_000L
        /** 提醒之后多久再排一次（用户一直不开 App 时，每天最多两条）。 */
        private const val RETRY_MS = 12L * 60 * 60 * 1000
        private const val MIN_DELAY_MS = 10_000L
        private const val MAX_DELAY_MS = 90L * DAY

        private const val CHANNEL_ID = "ellen-backup"
        private const val NOTIFICATION_ID = 0x4b32

        fun prefs(context: Context) =
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

        fun readState(context: Context): JSONObject {
            val raw = prefs(context).getString(KEY_STATE, "") ?: ""
            return try {
                if (raw.isBlank()) JSONObject() else JSONObject(raw)
            } catch (_: Exception) {
                JSONObject()
            }
        }

        /**
         * 到点时刻。优先级：nextAt → lastSuccessAt + intervalDays → now + intervalDays 兜底。
         * nextAt 是 configure/commit 写的绝对值；为 0 说明还没排过（老状态或刚打开开关）。
         */
        fun resolveAt(state: JSONObject, now: Long): Long {
            val next = state.optLong("nextAt", 0L)
            if (next > 0L) return next
            val days = state.optInt("intervalDays", 7).coerceIn(1, 90)
            val last = state.optLong("lastSuccessAt", 0L)
            return if (last > 0L) last + days * DAY else now + days * DAY
        }

        /** 按当前 state 重排一次。开关关了 / 没选文件夹就撤掉排期。 */
        fun scheduleNext(context: Context) {
            val state = readState(context)
            if (!state.optBoolean("enabled") || state.optString("directory").isBlank()) {
                cancel(context)
                return
            }
            schedule(context, resolveAt(state, System.currentTimeMillis()))
        }

        private fun schedule(context: Context, at: Long) {
            val delay = (at - System.currentTimeMillis()).coerceIn(MIN_DELAY_MS, MAX_DELAY_MS)
            val request = OneTimeWorkRequestBuilder<EllenBackupWorker>()
                .setInitialDelay(delay, TimeUnit.MILLISECONDS)
                .build()
            try {
                WorkManager.getInstance(context)
                    .enqueueUniqueWork(NAME, ExistingWorkPolicy.REPLACE, request)
            } catch (_: Exception) {
                /* WorkManager 没初始化（极少见）：下次 configure/commit 会再排 */
            }
        }

        fun cancel(context: Context) {
            try {
                WorkManager.getInstance(context).cancelUniqueWork(NAME)
            } catch (_: Exception) {
                /* 没排过就算了 */
            }
        }
    }
}
