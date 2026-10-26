package io.inspectorhub.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class UploadSharePolicyTest {

    @Test
    public void channelsExistFromApi26_notOn7x() {
        assertFalse(UploadSharePolicy.channelsExist(24));
        assertFalse(UploadSharePolicy.channelsExist(25));
        assertTrue(UploadSharePolicy.channelsExist(26));
        assertTrue(UploadSharePolicy.channelsExist(34));
    }

    @Test
    public void aLouderChannelIsRecreated_aLowOrBlockedOneIsLeftAlone() {
        // IMPORTANCE_MIN 1, LOW 2, DEFAULT 3, HIGH 4, MAX 5; NONE 0 is a channel the user blocked.
        assertTrue(UploadSharePolicy.mustRecreateChannel(3));
        assertTrue(UploadSharePolicy.mustRecreateChannel(4));
        assertTrue(UploadSharePolicy.mustRecreateChannel(5));
        assertFalse(UploadSharePolicy.mustRecreateChannel(2));
        assertFalse(UploadSharePolicy.mustRecreateChannel(1));
        assertFalse(UploadSharePolicy.mustRecreateChannel(0));
    }
}
