package io.inspectorhub.app;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import androidx.core.app.NotificationCompat;
import net.gotev.uploadservice.data.UploadInfo;
import net.gotev.uploadservice.data.UploadNotificationConfig;
import net.gotev.uploadservice.network.ServerResponse;
import net.gotev.uploadservice.observer.task.UploadTaskObserver;

/**
 * The only thing that posts upload notifications. The upload library's default handler posts a notification per file and per
 * progress tick; with many files that is hundreds of posts, and some vendors (observed on EMUI) then mute and demote every post of
 * the channel, so the user sees no upload notice at all. This observer replaces it (see {@link UploadShade#install}) and keeps
 * one record: the library's own foreground notice (id {@link #NOTIFICATION_ID}), whose content it updates, at most once per second
 * and only when the visible text or progress changed ({@link UploadShadeModel} decides). It never posts a per-file or a "completed"
 * notification; the library takes the foreground notice down itself when its last upload ends, and this class cancels it as well.
 */
final class UploadShadeObserver implements UploadTaskObserver {

    /** The id under which the library calls startForeground (its UPLOAD_NOTIFICATION_BASE_ID); updating that id updates the foreground notice in place. */
    static final int NOTIFICATION_ID = 1234;

    private final Context context;
    private final NotificationManager manager;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final UploadShadeModel model = new UploadShadeModel();
    private final Runnable flush = this::flushNow;
    private volatile String title = "Uploading";
    private boolean flushScheduled = false;

    UploadShadeObserver(Context context) {
        this.context = context.getApplicationContext();
        this.manager = (NotificationManager) this.context.getSystemService(Context.NOTIFICATION_SERVICE);
    }

    @Override
    public void onStart(UploadInfo info, int notificationId, UploadNotificationConfig config) {
        String configured = config.getProgress().getTitle();
        if (configured != null && !configured.isEmpty()) title = configured;
        model.onStart(info.getUploadId(), SystemClock.elapsedRealtime());
        dispatch();
    }

    @Override
    public void onProgress(UploadInfo info, int notificationId, UploadNotificationConfig config) {
        model.onProgress(info.getUploadId(), info.getProgressPercent());
        dispatch();
    }

    @Override
    public void onSuccess(UploadInfo info, int notificationId, UploadNotificationConfig config, ServerResponse response) {}

    @Override
    public void onError(UploadInfo info, int notificationId, UploadNotificationConfig config, Throwable exception) {}

    /** Called once per upload after success, error or cancel, so this is where a file counts as finished. */
    @Override
    public void onCompleted(UploadInfo info, int notificationId, UploadNotificationConfig config) {
        model.onFinished(info.getUploadId(), SystemClock.elapsedRealtime());
        dispatch();
    }

    private void dispatch() {
        handler.post(this::dispatchOnMain);
    }

    /** The held flush is over: clear the flag first, so whatever the plan says next (post, hold again, nothing, end) starts from a clean state. */
    private void flushNow() {
        flushScheduled = false;
        dispatchOnMain();
    }

    private void dispatchOnMain() {
        long now = SystemClock.elapsedRealtime();
        UploadShadeModel.Plan plan = model.plan(now);
        switch (plan.kind) {
            case POST:
                handler.removeCallbacks(flush);
                flushScheduled = false;
                post(plan.content);
                model.markPosted(plan.content, now);
                break;
            case LATER:
                if (!flushScheduled) {
                    flushScheduled = true;
                    handler.postDelayed(flush, plan.delayMs);
                }
                break;
            case END:
                handler.removeCallbacks(flush);
                flushScheduled = false;
                manager.cancel(NOTIFICATION_ID);
                break;
            case NOTHING:
            default:
                break;
        }
    }

    private void post(UploadShadeModel.Content content) {
        if (manager == null) return;
        String text = content.done + " of " + content.total + (content.total == 1 ? " file" : " files") + " uploaded";
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, UploadShade.UPLOAD_CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentTitle(title)
            .setContentText(text)
            .setProgress(100, content.percent, false)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE);
        Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        if (launch != null) {
            builder.setContentIntent(PendingIntent.getActivity(context, 0, launch, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
        }
        Notification notification = builder.build();
        manager.notify(NOTIFICATION_ID, notification);
    }
}
