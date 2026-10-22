package com.opgtr.echo;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Keeps Écho awake while songs download, screen locked included: Android
 * otherwise freezes the app a little after the screen goes off, and the
 * downloads (done by Écho's server inside the app) stop until it's unlocked.
 * A notification says what's downloading; the service stops by itself when
 * nothing is left.
 */
public class DownloadService extends Service {
    private static final String TAG = "EchoDownloads";
    private static final String CHANNEL = "echo-downloads";
    private static final int NOTIFICATION = 4242;
    private static final long MAX_MS = 3L * 60 * 60 * 1000;

    private PowerManager.WakeLock cpu;
    private WifiManager.WifiLock wifi;
    private Thread watcher;
    private volatile boolean running;
    private volatile int port;
    private volatile String token;

    /** Called by the app when downloads are queued; harmless when already running. */
    static void start(Context context, int port, String token) {
        Intent i = new Intent(context, DownloadService.class).putExtra("port", port).putExtra("token", token);
        try {
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(i); else context.startService(i);
        } catch (Exception e) {
            // Android refuses a new foreground service from the background (12+): nothing to do.
            Log.w(TAG, "start: " + e.getMessage());
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            port = intent.getIntExtra("port", port);
            String t = intent.getStringExtra("token");
            if (t != null) token = t;
        }
        Notification n = notification(getString(R.string.dl_starting), null, 0, true);
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            else startForeground(NOTIFICATION, n);
        } catch (Exception e) {
            Log.w(TAG, "foreground: " + e.getMessage());
            stopSelf();
            return START_NOT_STICKY;
        }
        hold();
        if (watcher == null) {
            running = true;
            watcher = new Thread(this::watch, "echo-downloads");
            watcher.start();
        }
        return START_NOT_STICKY;
    }

    private void hold() {
        try {
            if (cpu == null) {
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                cpu = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "echo:downloads");
                cpu.setReferenceCounted(false);
            }
            cpu.acquire(MAX_MS);
            if (wifi == null) {
                WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                @SuppressWarnings("deprecation")
                int mode = Build.VERSION.SDK_INT >= 29 ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
                wifi = wm.createWifiLock(mode, "echo:downloads");
                wifi.setReferenceCounted(false);
            }
            wifi.acquire();
        } catch (Exception e) { Log.w(TAG, "locks: " + e.getMessage()); }
    }

    /** Asks Écho's server what's left, every few seconds; stops when nothing is. */
    private void watch() {
        long started = System.currentTimeMillis();
        int idle = 0;
        while (running && System.currentTimeMillis() - started < MAX_MS) {
            try {
                JSONArray list = new JSONArray(get("/api/downloads"));
                int left = 0, pct = 0;
                String title = null;
                for (int i = 0; i < list.length(); i++) {
                    JSONObject d = list.getJSONObject(i);
                    String st = d.optString("status");
                    if (!st.equals("queued") && !st.equals("downloading") && !st.equals("saving")) continue;
                    left++;
                    if (title == null || st.equals("downloading")) { title = d.optString("title", null); pct = d.optInt("progress", 0); }
                }
                if (left == 0) { if (++idle >= 2) break; }
                else {
                    idle = 0;
                    String head = left == 1 ? getString(R.string.dl_one) : getString(R.string.dl_many, left);
                    NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
                    if (nm != null) nm.notify(NOTIFICATION, notification(head, title, pct, false));
                }
            } catch (Exception e) {
                // The server is starting or busy: try again shortly.
                if (++idle >= 20) break;
            }
            try { Thread.sleep(3000); } catch (InterruptedException e) { break; }
        }
        running = false;
        stopForeground(true);
        stopSelf();
    }

    private String get(String path) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL("http://127.0.0.1:" + port + path).openConnection();
        c.setConnectTimeout(3000);
        c.setReadTimeout(5000);
        if (token != null) c.setRequestProperty("x-echo-token", token);
        try (InputStream in = c.getInputStream()) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString("UTF-8");
        } finally { c.disconnect(); }
    }

    private Notification notification(String title, @Nullable String text, int pct, boolean indeterminate) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm != null && nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, getString(R.string.dl_channel), NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(this, 1, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_echo)
            .setContentTitle(title)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setContentIntent(tap)
            .setProgress(100, Math.max(0, Math.min(100, pct)), indeterminate || pct <= 0);
        if (text != null && !text.isEmpty()) b.setContentText(text);
        return b.build();
    }

    @Override
    public void onDestroy() {
        running = false;
        if (watcher != null) watcher.interrupt();
        try { if (cpu != null && cpu.isHeld()) cpu.release(); } catch (Exception ignored) {}
        try { if (wifi != null && wifi.isHeld()) wifi.release(); } catch (Exception ignored) {}
        super.onDestroy();
    }

    /** Android 15+: a data-sync service has a daily time budget; when it runs out, stop cleanly. */
    @Override
    public void onTimeout(int startId, int fgsType) { stopSelf(); }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) { return null; }
}
