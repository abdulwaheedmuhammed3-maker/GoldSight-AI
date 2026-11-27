package com.tradesight.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.content.Context;

import androidx.core.app.NotificationCompat;

public final class MarketMonitorService extends Service {
    public static final String ACTION_START = "com.tradesight.mobile.action.START_MARKET_MONITOR";
    public static final String ACTION_STOP = "com.tradesight.mobile.action.STOP_MARKET_MONITOR";
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_BODY = "body";

    private static final String CHANNEL_ID = "tradesight-background-monitor";
    private static final int NOTIFICATION_ID = 7321;
    private static final String PREFS = "tradesight_market_monitor";
    private static final String PREF_RUNNING = "running";
    private static final String PREF_STARTED_AT = "started_at";
    private static final String PREF_STOP_REASON = "stop_reason";

    private PowerManager.WakeLock wakeLock;

    public static boolean isRunning(Context context) {
        return context.getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean(PREF_RUNNING, false);
    }

    public static long getStartedAt(Context context) {
        return context.getSharedPreferences(PREFS, MODE_PRIVATE).getLong(PREF_STARTED_AT, 0L);
    }

    public static String getStopReason(Context context) {
        return context.getSharedPreferences(PREFS, MODE_PRIVATE).getString(PREF_STOP_REASON, null);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopMonitoring("Stopped by user");
            return START_NOT_STICKY;
        }

        String title = intent != null ? intent.getStringExtra(EXTRA_TITLE) : null;
        String body = intent != null ? intent.getStringExtra(EXTRA_BODY) : null;
        if (title == null || title.trim().isEmpty()) title = "TradeSight monitoring active";
        if (body == null || body.trim().isEmpty()) body = "Live market monitoring session is active.";

        Notification notification = buildNotification(title, body);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
                );
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
        } catch (RuntimeException error) {
            getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                .putBoolean(PREF_RUNNING, false)
                .putString(PREF_STOP_REASON, "Android refused to start the foreground service: " + error.getClass().getSimpleName())
                .apply();
            stopSelf();
            return START_NOT_STICKY;
        }

        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
            .putBoolean(PREF_RUNNING, true)
            .putLong(PREF_STARTED_AT, System.currentTimeMillis())
            .putString(PREF_STOP_REASON, null)
            .apply();

        acquireWakeLock();
        return START_STICKY;
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;

        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "TradeSight background monitoring",
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Visible notification while a market monitoring session is active.");
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }

    private Notification buildNotification(String title, String body) {
        Intent openAppIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent contentIntent = null;
        if (openAppIntent != null) {
            openAppIntent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            contentIntent = PendingIntent.getActivity(
                this,
                7321,
                openAppIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );
        }

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(getApplicationInfo().icon)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false);

        if (contentIntent != null) builder.setContentIntent(contentIntent);
        return builder.build();
    }

    private void acquireWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) return;
        PowerManager manager = (PowerManager) getSystemService(POWER_SERVICE);
        if (manager == null) return;
        wakeLock = manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "TradeSight:MarketMonitor");
        // Android 15 dataSync foreground services have a six-hour/24h quota.
        wakeLock.acquire(5L * 60L * 60L * 1000L + 50L * 60L * 1000L);
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
    }

    private void stopMonitoring(String reason) {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
            .putBoolean(PREF_RUNNING, false)
            .putString(PREF_STOP_REASON, reason)
            .apply();
        releaseWakeLock();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE);
        } else {
            stopForeground(true);
        }
        stopSelf();
    }

    @Override
    public void onTimeout(int startId, int fgsType) {
        stopMonitoring("Android foreground-service time limit reached. Reopen TradeSight to start a new session.");
    }

    @Override
    public void onDestroy() {
        releaseWakeLock();
        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
            .putBoolean(PREF_RUNNING, false)
            .apply();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
