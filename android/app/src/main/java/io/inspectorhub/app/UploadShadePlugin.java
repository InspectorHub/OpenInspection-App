package io.inspectorhub.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.service.notification.StatusBarNotification;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Keeps the notification shade quiet while photos upload. The upload plugin posts to one channel with a fixed id: its foreground
 * service shows the ongoing "Uploading photos" notice, and it also posts one "Completed" notification per file and leaves it behind.
 * This class creates that channel first, with low importance (no sound, no vibration, no heads-up), and removes the finished
 * notifications on request. Android cannot raise or lower a channel that already exists, so the channel has to be ours before the
 * plugin loads.
 */
@CapacitorPlugin(name = "UploadShade")
public class UploadShadePlugin extends Plugin {

    /** The channel id of the upload plugin; a test reads it from the plugin's own source. */
    static final String UPLOAD_CHANNEL_ID = "ee.forgr.capacitor.uploader.notification_channel_id";

    private static final long[] LATE_CLEAR_DELAYS_MS = {1500L, 5000L};

    private final Handler handler = new Handler(Looper.getMainLooper());

    /** Creates the channel quietly. Does nothing where the channel already exists or the platform has no channels. */
    static void ensureQuietChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(UPLOAD_CHANNEL_ID, "Upload progress", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Shown while photos and videos upload in the background");
        channel.setSound(null, null);
        channel.enableVibration(false);
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }

    /** Removes the finished notifications of the upload channel; the ongoing one of the foreground service stays. */
    static void clearFinished(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        for (StatusBarNotification posted : manager.getActiveNotifications()) {
            Notification notification = posted.getNotification();
            if (!UPLOAD_CHANNEL_ID.equals(notification.getChannelId())) continue;
            if (posted.isOngoing() || (notification.flags & Notification.FLAG_FOREGROUND_SERVICE) != 0) continue;
            manager.cancel(posted.getTag(), posted.getId());
        }
    }

    @PluginMethod
    public void tidy(PluginCall call) {
        final Context context = getContext();
        clearFinished(context);
        // The plugin may post a file's notification just after it reports the file, so clear again a little later.
        for (long delay : LATE_CLEAR_DELAYS_MS) {
            handler.postDelayed(() -> clearFinished(context), delay);
        }
        call.resolve();
    }
}
