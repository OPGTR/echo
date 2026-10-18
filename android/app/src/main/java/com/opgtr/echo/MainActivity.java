package com.opgtr.echo;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(EchoNativePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
