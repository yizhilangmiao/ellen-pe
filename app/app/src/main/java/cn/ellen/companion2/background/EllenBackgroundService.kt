package cn.ellen.companion2.background

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import cn.ellen.companion2.MainActivity
import cn.ellen.companion2.R

/**
 * 前台保活服务：让「话还没说完就切走」不被打断。
 *
 * 只是低压常驻（无声、不可划掉、IMPORTANCE_LOW）。真正保命的是
 * foregroundServiceType=dataSync —— Android 14 起从后台起前台服务要求类型匹配且有权限。
 */
class EllenBackgroundService : Service() {

    private var running = false
    private var text = "在这里"

    private fun channel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "在这里", NotificationManager.IMPORTANCE_LOW).apply {
                description = "她在说话的时候，先把这段说完"
                setSound(null, null)
                setShowBadge(false)
            }
        )
    }

    private fun notification(text: String): Notification {
        channel(this)
        val open = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pi = PendingIntent.getActivity(
            this,
            NOTIFICATION_ID,
            open,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_ellen_notify)
            .setColor(0xFFE4B8CD.toInt())
            .setContentTitle("艾莲")
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(pi)
            .build()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action ?: ACTION_START
        if (action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }

        val wording = intent?.getStringExtra(EXTRA_TEXT) ?: text
        text = wording

        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    NOTIFICATION_ID,
                    notification(wording),
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
                )
            } else {
                startForeground(NOTIFICATION_ID, notification(wording))
            }
            running = true
            START_NOT_STICKY
        } catch (e: Exception) {
            // Android 12+ 从后台起前台服务会被拒（uidState: LAST），别把进程拖崩
            running = false
            val detail = "${e.javaClass.simpleName}: ${e.message.orEmpty()}".take(160)
            EllenBackgroundState.updateState(this) {
                it.put("running", false)
                it.put("lastError", detail)
            }
            stopSelf()
            START_NOT_STICKY
        }
    }

    override fun onDestroy() {
        running = false
        // 先撤前台再退（ServiceCompat 会吞掉旧系统的差异）
        try {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        } catch (_: Exception) {
            /* 已经撤过 */
        }
        EllenBackgroundState.updateState(this) { it.put("running", false) }
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        const val ACTION_START = "cn.ellen.companion2.action.BACKGROUND_START"
        const val ACTION_STOP = "cn.ellen.companion2.action.BACKGROUND_STOP"
        const val EXTRA_TEXT = "text"
        const val CHANNEL_ID = "ellen-background-v1"
        const val NOTIFICATION_ID = 0x4b3

        fun start(context: Context, text: String): Boolean {
            val intent = Intent(context, EllenBackgroundService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_TEXT, text)
            }
            return try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
                true
            } catch (e: Exception) {
                false
            }
        }

        fun stop(context: Context) {
            try {
                context.startService(Intent(context, EllenBackgroundService::class.java).apply {
                    action = ACTION_STOP
                })
            } catch (_: Exception) {
                /* 服务没跑 */
            }
        }
    }
}
