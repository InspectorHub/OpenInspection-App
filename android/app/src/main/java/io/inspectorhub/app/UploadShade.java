package io.inspectorhub.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.os.Build;
import android.service.notification.StatusBarNotification;
import net.gotev.uploadservice.UploadService;
import net.gotev.uploadservice.UploadServiceConfig;

/**
 * Keeps the notification shade quiet and single while photos upload. The upload library posts to one channel: its foreground
 * service shows an ongoing notice, and its default notification handler adds one notification per file and per progress tick plus a
 * "Completed" one per file. Hundreds of posts make some vendors (EMUI) mute and demote the channel, which hides even the ongoing
 * notice. {@link #install} swaps the handler for {@link UploadShadeObserver}, which updates the ongoing notice only, rate limited.
 * This class also creates the channel first with low importance (no sound, no vibration, no heads-up), because Android cannot raise
 * or lower a channel that already exists, and removes records left behind by an earlier run or a crash.
 */
final class UploadShade {

    /** The channel id of the upload plugin; a test reads it from the plugin's own source. */
    static final String UPLOAD_CHANNEL_ID = "ee.forgr.capacitor.uploader.notification_channel_id";

    private UploadShade() {}

    /**
     * Call from the activity before the bridge loads. Creates the channel quietly, replaces the library's per-file notification
     * handler with the single-notice one (a service started later picks up the factory; the library does not reset it when the upload
     * plugin initialises it), and removes stale records.
     */
    static void install(Context context) {
        ensureQuietChannel(context);
        UploadServiceConfig.setNotificationHandlerFactory(service -> new UploadShadeObserver(service));
        clearStale(context);
    }

    /** Creates the channel quietly. Replaces an existing channel that is louder than LOW. Does nothing where the platform has no channels (before Android 8). */
    static void ensureQuietChannel(Context context) {
        if (!UploadSharePolicy.channelsExist(Build.VERSION.SDK_INT)) return;
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        // An existing channel keeps the importance it was created with, so one an earlier version made louder is replaced. The channel
        // only carries upload progress, and this runs before the library can post to it.
        NotificationChannel existing = manager.getNotificationChannel(UPLOAD_CHANNEL_ID);
        if (existing != null && UploadSharePolicy.mustRecreateChannel(existing.getImportance())) {
            manager.deleteNotificationChannel(UPLOAD_CHANNEL_ID);
        }
        NotificationChannel channel = new NotificationChannel(UPLOAD_CHANNEL_ID, "Upload progress", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Shown while photos and videos upload in the background");
        channel.setSound(null, null);
        channel.enableVibration(false);
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }

    /**
     * Removes notifications of the upload channel when no upload is running: a foreground notice a crash left behind, or the
     * per-file ones of an app version that posted them. With an upload running it does nothing, so a recreated activity never
     * touches the live notice.
     */
    static void clearStale(Context context) {
        // Notification.getChannelId() exists from API 26 only; before that there are no channels and nothing channel-scoped to clear.
        if (!UploadSharePolicy.channelsExist(Build.VERSION.SDK_INT)) return;
        if (!UploadService.getTaskList().isEmpty()) return;
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        for (StatusBarNotification posted : manager.getActiveNotifications()) {
            if (!UPLOAD_CHANNEL_ID.equals(posted.getNotification().getChannelId())) continue;
            manager.cancel(posted.getTag(), posted.getId());
        }
    }
}
