package cn.ellen.companion2.proactive

import android.Manifest
import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import java.util.Calendar

/**
 * 排下一次主动消息。
 *
 * 关键取舍：**先试精确闹钟，失败再退降级**。
 * 上一版是「先问 canScheduleExactAlarms() 再决定用哪个」，结果 Android 14 上
 * SCHEDULE_EXACT_ALARM 默认被拒 → canScheduleExactAlarms() 恒 false → 永远走
 * setAndAllowWhileIdle → dumpsys 里 window=+1h0m0s0ms，用户看到的就是「说好一小时后，拖到两小时」。
 * 现在直接调 setExactAndAllowWhileIdle，捕获 SecurityException 才降级（清单里也加了
 * USE_EXACT_ALARM，正常安装即授予）。
 */
object EllenProactiveScheduler {

    const val ACTION_TICK = "cn.ellen.companion2.action.PROACTIVE_TICK"
    private const val REQUEST_CODE = 0x4b31
    private const val MIN_DELAY_MS = 5_000L
    private const val MAX_DELAY_MS = 24L * 60 * 60 * 1000

    private fun intent(context: Context): Intent = Intent(context, EllenProactiveReceiver::class.java).apply {
        action = ACTION_TICK
    }

    private fun pending(context: Context): PendingIntent = PendingIntent.getBroadcast(
        context,
        REQUEST_CODE,
        intent(context),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    private fun alarm(context: Context): AlarmManager? =
        context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager

    /** 真正把闹钟挂上。返回是否拿到了精确闹钟。 */
    fun arm(context: Context, at: Long): Boolean {
        val manager = alarm(context) ?: return false
        val pi = pending(context)
        val when0 = at.coerceAtLeast(System.currentTimeMillis() + MIN_DELAY_MS)
        return try {
            manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, when0, pi)
            true
        } catch (e: SecurityException) {
            try {
                manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, when0, pi)
            } catch (_: Exception) {
                /* 连降级都挂不上：下次启动会重排，不在这里刷屏 */
            }
            false
        } catch (e: Exception) {
            false
        }
    }

    fun cancel(context: Context) {
        try {
            alarm(context)?.cancel(pending(context))
        } catch (_: Exception) {
            /* 没挂过就算了 */
        }
    }

    /** 按素材里的 min/max 间隔和安静时段算出下一次，写进 store 并挂闹钟。 */
    fun scheduleNext(context: Context): Long {
        val material = EllenProactiveStore.readMaterial(context)
        if (material == null || !EllenProactiveStore.enabled(context)) {
            cancel(context)
            EllenProactiveStore.setNextAt(context, 0L)
            return 0L
        }

        val now = System.currentTimeMillis()
        val last = EllenProactiveStore.lastAt(context)
        val minGap = material.minGapMs.coerceAtLeast(1_000L)
        val maxGap = material.maxGapMs.coerceAtLeast(minGap)
        // 用一个稳定的伪随机（按 lastAt 取模）在区间里挑一点，避免每轮都是同样的间隔
        val span = (maxGap - minGap).coerceAtLeast(0L)
        val pick = if (span <= 0) minGap else minGap + ((last / 1000L) % (span / 1000L + 1)) * 1000L
        var at = (if (last > 0) last else now) + pick

        // 安静时段：落进去就推到 quietEnd 点
        val start = material.quietStart.coerceIn(0, 23)
        val end = material.quietEnd.coerceIn(0, 23)
        if (start != end) {
            val cal = Calendar.getInstance().apply { timeInMillis = at }
            val hour = cal.get(Calendar.HOUR_OF_DAY)
            val inside = if (start < end) hour in start until end else (hour >= start || hour < end)
            if (inside) {
                cal.set(Calendar.HOUR_OF_DAY, end)
                cal.set(Calendar.MINUTE, 0)
                cal.set(Calendar.SECOND, 0)
                cal.set(Calendar.MILLISECOND, 0)
                if (cal.timeInMillis <= at) cal.add(Calendar.DAY_OF_YEAR, 1)
                at = cal.timeInMillis
            }
        }

        val bounded = at.coerceAtMost(now + MAX_DELAY_MS)
        EllenProactiveStore.setNextAt(context, bounded)
        arm(context, bounded)
        return bounded
    }

    /** 调试/测试用：delayMs 之后跑一次。 */
    fun scheduleIn(context: Context, delayMs: Long): Long {
        val at = System.currentTimeMillis() + delayMs.coerceIn(MIN_DELAY_MS, MAX_DELAY_MS)
        val exact = arm(context, at)
        EllenProactiveStore.setNextAt(context, at)
        return if (exact) at else at
    }

    fun permissionState(context: Context): String {
        val notifications = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
                PackageManager.PERMISSION_GRANTED
        } else {
            true
        }
        if (!notifications) return "prompt"

        val manager = alarm(context)
        val exact = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            manager?.canScheduleExactAlarms() ?: false
        } else {
            true
        }
        return if (exact) "granted" else "approx"
    }
}
