package io.inspectorhub.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Before the upload plugin loads: it creates its channel with default importance, and an existing channel is never changed.
        UploadShadePlugin.ensureQuietChannel(this);
        registerPlugin(UploadShadePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
