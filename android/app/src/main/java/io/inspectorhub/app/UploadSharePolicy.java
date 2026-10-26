package io.inspectorhub.app;

/** Decisions about the upload channel that depend only on numbers, so a plain JVM test can cover them. */
final class UploadSharePolicy {

    /** Android 8.0 (API 26), where notification channels and {@code Notification.getChannelId()} first exist. */
    private static final int FIRST_CHANNEL_SDK = 26;

    /** NotificationManager.IMPORTANCE_LOW. */
    private static final int IMPORTANCE_LOW = 2;

    private UploadSharePolicy() {}

    /** True where channels exist; a channel-scoped step must do nothing (and call no channel API) below it. */
    static boolean channelsExist(int sdkInt) {
        return sdkInt >= FIRST_CHANNEL_SDK;
    }

    /**
     * Android never changes an existing channel, so one created at a louder importance by an earlier version stays loud. It is
     * recreated as LOW only when it is louder than LOW. A blocked channel (importance NONE, 0) is not louder, so it is left alone:
     * deleting and recreating it would undo the user's choice.
     */
    static boolean mustRecreateChannel(int existingImportance) {
        return existingImportance > IMPORTANCE_LOW;
    }
}
