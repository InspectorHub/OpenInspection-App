package io.inspectorhub.app;

import java.util.HashMap;
import java.util.Map;

/**
 * What the one upload notification says, and when it may be posted. No Android types, so it runs in a plain JVM test.
 *
 * A run starts with the first upload and ends when the last one has finished. Within a run the notification shows how many files
 * are done and the overall progress in coarse steps. It is posted at most once per {@link #MIN_INTERVAL_MS} and only when what the
 * user can see changed; a change that arrives inside the interval is held and posted when the interval is over, so the last state
 * of a burst is never lost.
 */
final class UploadShadeModel {

    /** The least time between two posts to the system. Below this some vendors (EMUI) mute and demote the whole channel. */
    static final long MIN_INTERVAL_MS = 1000L;

    /** Uploads that start within this long after a run ended count as the same run (the library ends its notice between uploads that run one after another). */
    static final long RUN_GAP_MS = 10_000L;

    /** The overall percent is shown in steps of this size, so a progress tick that moves it by one does not post. */
    static final int PERCENT_STEP = 5;

    /** What is visible: files finished, files in the run, overall percent (a multiple of {@link #PERCENT_STEP}). */
    static final class Content {
        final int done;
        final int total;
        final int percent;

        Content(int done, int total, int percent) {
            this.done = done;
            this.total = total;
            this.percent = percent;
        }

        @Override
        public boolean equals(Object other) {
            if (!(other instanceof Content)) return false;
            Content that = (Content) other;
            return done == that.done && total == that.total && percent == that.percent;
        }

        @Override
        public int hashCode() {
            return (done * 31 + total) * 31 + percent;
        }
    }

    enum Kind {
        /** Nothing to do: what is visible is already what the system has. */
        NOTHING,
        /** Post {@link Plan#content} now. */
        POST,
        /** Post later: call {@link #plan} again after {@link Plan#delayMs}. */
        LATER,
        /** The run is over: remove the notification and cancel anything held. */
        END,
    }

    static final class Plan {
        final Kind kind;
        final Content content;
        final long delayMs;

        Plan(Kind kind, Content content, long delayMs) {
            this.kind = kind;
            this.content = content;
            this.delayMs = delayMs;
        }
    }

    private final Map<String, Integer> active = new HashMap<>();
    private int total = 0;
    private int done = 0;
    private boolean ended = false;
    private long endedAtMs = 0L;
    private Content lastPosted = null;
    private long lastPostAtMs = 0L;
    /** True when the system may be showing something other than {@link #lastPosted} (the service re-posts its bare notice on every start). */
    private boolean stale = true;

    /**
     * A file started. The service has just posted its own bare foreground notice over ours, so what we last posted no longer shows;
     * the next plan posts again, still no sooner than the interval allows. A start soon after the previous run ended continues that
     * run (uploads that run one after another are one run to the user); a later one begins a new run.
     */
    synchronized void onStart(String id, long nowMs) {
        if (ended) {
            if (nowMs - endedAtMs > RUN_GAP_MS) resetRun();
            ended = false;
        }
        if (!active.containsKey(id)) {
            active.put(id, 0);
            total += 1;
        }
        stale = true;
    }

    synchronized void onProgress(String id, int percent) {
        if (!active.containsKey(id)) return;
        active.put(id, Math.max(0, Math.min(100, percent)));
    }

    /** A file reached a terminal state (done, failed or cancelled). When it was the last, the run ends. */
    synchronized void onFinished(String id, long nowMs) {
        if (active.remove(id) == null) return;
        done += 1;
        if (active.isEmpty()) {
            ended = true;
            endedAtMs = nowMs;
        }
    }

    /** What to do now. Call after every change, and again when a {@link Kind#LATER} delay is over. */
    synchronized Plan plan(long nowMs) {
        if (ended) return new Plan(Kind.END, null, 0L);
        if (total == 0) return new Plan(Kind.NOTHING, null, 0L);
        Content content = current();
        if (!stale && content.equals(lastPosted)) return new Plan(Kind.NOTHING, content, 0L);
        long wait = lastPostAtMs + MIN_INTERVAL_MS - nowMs;
        if (lastPostAtMs > 0L && wait > 0L) return new Plan(Kind.LATER, content, wait);
        return new Plan(Kind.POST, content, 0L);
    }

    /** Record that {@code content} was handed to the system at {@code nowMs}. */
    synchronized void markPosted(Content content, long nowMs) {
        lastPosted = content;
        lastPostAtMs = nowMs;
        stale = false;
    }

    private Content current() {
        long sum = 100L * done;
        for (int percent : active.values()) sum += percent;
        int overall = total == 0 ? 0 : (int) (sum / total);
        return new Content(done, total, overall / PERCENT_STEP * PERCENT_STEP);
    }

    private void resetRun() {
        active.clear();
        total = 0;
        done = 0;
        ended = false;
        lastPosted = null;
        lastPostAtMs = 0L;
        stale = true;
    }
}
