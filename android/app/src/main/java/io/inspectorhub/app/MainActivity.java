package io.inspectorhub.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Before the upload plugin loads: it creates its channel with default importance, and an existing channel is never changed.
        // The same call installs the single upload notification and removes notifications a crashed run left behind.
        UploadShade.install(this);
        super.onCreate(savedInstanceState);
    }
}
