package io.inspectorhub.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

import org.junit.Test;

public class UploadShadeModelTest {

    private static final long T0 = 100_000L;

    /** Plans, and when the plan is POST records it as posted, the way the observer does. */
    private static UploadShadeModel.Plan step(UploadShadeModel model, long now) {
        UploadShadeModel.Plan plan = model.plan(now);
        if (plan.kind == UploadShadeModel.Kind.POST) model.markPosted(plan.content, now);
        return plan;
    }

    @Test
    public void firstStartPostsImmediately() {
        UploadShadeModel model = new UploadShadeModel();
        model.onStart("a", T0);
        UploadShadeModel.Plan plan = step(model, T0);
        assertEquals(UploadShadeModel.Kind.POST, plan.kind);
        assertEquals(new UploadShadeModel.Content(0, 1, 0), plan.content);
    }

    @Test
    public void aSecondChangeInsideTheIntervalWaitsForTheRestOfTheInterval() {
        UploadShadeModel model = new UploadShadeModel();
        model.onStart("a", T0);
        step(model, T0);
        model.onProgress("a", 50);
        UploadShadeModel.Plan plan = step(model, T0 + 300L);
        assertEquals(UploadShadeModel.Kind.LATER, plan.kind);
        assertEquals(700L, plan.delayMs);
        // Control: once the interval is over the same change is posted.
        UploadShadeModel.Plan later = step(model, T0 + 1000L);
        assertEquals(UploadShadeModel.Kind.POST, later.kind);
        assertEquals(50, later.content.percent);
    }

    @Test
    public void manyTicksInOneSecondMakeOnePostWithTheLastState() {
        UploadShadeModel model = new UploadShadeModel();
        model.onStart("a", T0);
        step(model, T0);
        int posts = 0;
        for (int percent = 1; percent <= 100; percent++) {
            model.onProgress("a", percent);
            if (step(model, T0 + percent * 5L).kind == UploadShadeModel.Kind.POST) posts++;
        }
        assertEquals(0, posts);
        UploadShadeModel.Plan flush = step(model, T0 + 1000L);
        assertEquals(UploadShadeModel.Kind.POST, flush.kind);
        assertEquals(100, flush.content.percent);
    }

    @Test
    public void aTickThatDoesNotMoveTheCoarsePercentPostsNothing() {
        UploadShadeModel model = new UploadShadeModel();
        model.onStart("a", T0);
        step(model, T0);
        model.onProgress("a", 4);
        assertEquals(UploadShadeModel.Kind.NOTHING, step(model, T0 + 5000L).kind);
        // Control: the step that does move it posts.
        model.onProgress("a", 5);
        UploadShadeModel.Plan plan = step(model, T0 + 5000L);
        assertEquals(UploadShadeModel.Kind.POST, plan.kind);
        assertEquals(5, plan.content.percent);
    }

    @Test
    public void percentIsOverallAcrossFinishedAndRunningFiles() {
        UploadShadeModel model = new UploadShadeModel();
        model.onStart("a", T0);
        model.onStart("b", T0);
        model.onProgress("a", 100);
        model.onFinished("a", T0);
        model.onProgress("b", 50);
        UploadShadeModel.Plan plan = model.plan(T0);
        assertEquals(new UploadShadeModel.Content(1, 2, 75), plan.content);
    }

    @Test
    public void aStartReposts_becauseTheServicePostedItsBareNoticeOverOurs_butStillWaitsForTheInterval() {
        UploadShadeModel model = new UploadShadeModel();
        model.onStart("a", T0);
        step(model, T0);
        assertEquals(UploadShadeModel.Kind.NOTHING, step(model, T0 + 5000L).kind);
        model.onStart("b", T0 + 5000L);
        UploadShadeModel.Plan plan = step(model, T0 + 5000L);
        assertEquals(UploadShadeModel.Kind.POST, plan.kind);
        assertEquals(2, plan.content.total);
        // The start after that, 100 ms later, is held to the interval.
        model.onStart("c", T0 + 5100L);
        UploadShadeModel.Plan held = step(model, T0 + 5100L);
        assertEquals(UploadShadeModel.Kind.LATER, held.kind);
        assertEquals(900L, held.delayMs);
    }

    @Test
    public void aRestartOfTheSameFileRepostsEvenThoughTheVisibleContentIsTheSame() {
        UploadShadeModel model = new UploadShadeModel();
        model.onStart("a", T0);
        step(model, T0);
        // Control: without a start the identical content posts nothing.
        assertEquals(UploadShadeModel.Kind.NOTHING, step(model, T0 + 5000L).kind);
        // A retry starts the same file again; the service has re-posted its bare notice over ours.
        model.onStart("a", T0 + 5000L);
        UploadShadeModel.Plan plan = step(model, T0 + 5000L);
        assertEquals(UploadShadeModel.Kind.POST, plan.kind);
        assertEquals(new UploadShadeModel.Content(0, 1, 0), plan.content);
        // And once reposted it is quiet again.
        assertEquals(UploadShadeModel.Kind.NOTHING, step(model, T0 + 9000L).kind);
    }

    @Test
    public void twentyUploadsStartedInOneSecondPostAtMostOnceMore() {
        UploadShadeModel model = new UploadShadeModel();
        int posts = 0;
        for (int i = 0; i < 20; i++) {
            long now = T0 + i * 40L;
            model.onStart("u" + i, now);
            if (step(model, now).kind == UploadShadeModel.Kind.POST) posts++;
        }
        assertEquals(1, posts);
        UploadShadeModel.Plan flush = step(model, T0 + 1000L);
        assertEquals(UploadShadeModel.Kind.POST, flush.kind);
        assertEquals(20, flush.content.total);
    }

    @Test
    public void theRunEndsWhenTheLastFileFinishes_andNotBefore() {
        UploadShadeModel model = new UploadShadeModel();
        model.onStart("a", T0);
        model.onStart("b", T0);
        model.onFinished("a", T0 + 10L);
        assertNotEnd(model.plan(T0 + 10L));
        model.onFinished("b", T0 + 20L);
        UploadShadeModel.Plan plan = model.plan(T0 + 20L);
        assertEquals(UploadShadeModel.Kind.END, plan.kind);
        assertNull(plan.content);
    }

    private static void assertNotEnd(UploadShadeModel.Plan plan) {
        assertNotNull(plan);
        assertEquals(false, plan.kind == UploadShadeModel.Kind.END);
    }

    @Test
    public void aFailedOrCancelledFileEndsTheRunLikeADoneOne_andAnUnknownIdChangesNothing() {
        UploadShadeModel model = new UploadShadeModel();
        model.onStart("a", T0);
        model.onFinished("ghost", T0);
        model.onProgress("ghost", 90);
        assertEquals(UploadShadeModel.Kind.POST, model.plan(T0).kind);
        model.onFinished("a", T0 + 5L);
        assertEquals(UploadShadeModel.Kind.END, model.plan(T0 + 5L).kind);
    }

    @Test
    public void aStartSoonAfterTheRunEndedContinuesIt_andALaterOneBeginsANewRun() {
        UploadShadeModel model = new UploadShadeModel();
        model.onStart("a", T0);
        model.onFinished("a", T0 + 100L);
        model.onStart("b", T0 + 2000L);
        assertEquals(new UploadShadeModel.Content(1, 2, 50), model.plan(T0 + 2000L).content);

        UploadShadeModel fresh = new UploadShadeModel();
        fresh.onStart("a", T0);
        fresh.onFinished("a", T0 + 100L);
        fresh.onStart("b", T0 + 100L + UploadShadeModel.RUN_GAP_MS + 1L);
        assertEquals(new UploadShadeModel.Content(0, 1, 0), fresh.plan(T0 + 20_000L).content);
    }

    @Test
    public void aChangeHeldInsideTheWindowIsFlushedWhenTheWindowEnds_butTheEndWinsWhenTheRunEndsFirst() {
        UploadShadeModel model = new UploadShadeModel();
        model.onStart("a", T0);
        model.onStart("b", T0);
        step(model, T0);
        model.onProgress("a", 60);
        UploadShadeModel.Plan held = step(model, T0 + 200L);
        assertEquals(UploadShadeModel.Kind.LATER, held.kind);
        // Control: when the run goes on, the held change is posted once the window is over.
        UploadShadeModel.Plan flushed = model.plan(T0 + 1000L);
        assertEquals(UploadShadeModel.Kind.POST, flushed.kind);
        assertEquals(30, flushed.content.percent);
        // The run ends inside the window instead: the flush that fires later finds END, not a post.
        model.onFinished("a", T0 + 300L);
        model.onFinished("b", T0 + 400L);
        assertEquals(UploadShadeModel.Kind.END, model.plan(T0 + 500L).kind);
        assertEquals(UploadShadeModel.Kind.END, model.plan(T0 + 1000L).kind);
    }

    @Test
    public void nothingToShowBeforeTheFirstStart() {
        assertEquals(UploadShadeModel.Kind.NOTHING, new UploadShadeModel().plan(T0).kind);
    }
}
