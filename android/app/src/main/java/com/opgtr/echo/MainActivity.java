package com.opgtr.echo;

import android.app.Activity;
import android.graphics.drawable.ColorDrawable;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(EchoNativePlugin.class);
        registerPlugin(EchoPlayerPlugin.class);
        super.onCreate(savedInstanceState);
        // Behind the app while it starts: the color of the theme you chose.
        paintWindow(this, getSharedPreferences("echo", MODE_PRIVATE).getString("theme", "indigo"));
    }

    static void paintWindow(Activity activity, String theme) {
        int color = "luce".equals(theme) ? 0xFF111111 : "glass".equals(theme) ? 0xFF0E0E11 : 0xFF1A1838;
        activity.getWindow().setBackgroundDrawable(new ColorDrawable(color));
        if (activity instanceof BridgeActivity && ((BridgeActivity) activity).getBridge() != null) {
            ((BridgeActivity) activity).getBridge().getWebView().setBackgroundColor(color);
        }
    }
}
