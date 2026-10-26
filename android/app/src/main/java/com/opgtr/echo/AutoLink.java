package com.opgtr.echo;

import android.content.Context;
import android.util.Log;

import androidx.annotation.Nullable;

import com.google.common.util.concurrent.ListenableFuture;
import com.google.common.util.concurrent.SettableFuture;

import net.hampoelz.capacitor.nodejs.CapacitorNodeJS;

import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The player's line to Écho's server (Node.js inside the app, on 127.0.0.1),
 * for the car: what to list, what to play. In the car Écho may not have been
 * opened at all (phone in the pocket): then the player starts Node.js itself.
 * The server tells where it is and its secret in its "echo-ready" message.
 */
final class AutoLink {
    private static final String TAG = "EchoAuto";
    private static final Object lock = new Object();
    private static volatile int port = 3433;
    private static volatile String token;
    private static volatile String mediaToken;
    private static boolean hooked;
    static final ExecutorService io = Executors.newFixedThreadPool(3);

    private AutoLink() {}

    /** Starts listening to Node.js, and Node.js itself when the app hasn't. Harmless when called again. */
    static void init(Context context) {
        synchronized (lock) {
            if (!hooked) {
                hooked = true;
                CapacitorNodeJS.echoHook = (name, message) -> {
                    if ("echo-ready".equals(name)) ready(message);
                };
            }
        }
        try {
            if (CapacitorNodeJS.echoStart(context.getApplicationContext(), "nodejs")) Log.i(TAG, "Node.js started by the player (car)");
        } catch (Throwable e) {
            Log.w(TAG, "start: " + e.getMessage());
        }
    }

    /** ["{\"port\":3433,\"token\":…,\"mediaToken\":…}"] */
    private static void ready(String message) {
        try {
            JSONArray args = new JSONArray(message);
            JSONObject info = new JSONObject(args.getString(0));
            synchronized (lock) {
                port = info.optInt("port", port);
                token = info.optString("token", null);
                mediaToken = info.optString("mediaToken", null);
                lock.notifyAll();
            }
        } catch (Exception e) {
            Log.w(TAG, "ready: " + e.getMessage());
        }
    }

    static boolean connected() { return token != null; }
    @Nullable static String mediaToken() { return mediaToken; }
    static int port() { return port; }

    /** Waits for the server (up to `ms`), asking Node.js to say where it is. */
    static boolean await(long ms) {
        long end = System.currentTimeMillis() + ms;
        long asked = 0;
        synchronized (lock) {
            while (token == null) {
                long now = System.currentTimeMillis();
                if (now >= end) return false;
                if (now - asked > 1500) {
                    asked = now;
                    try { CapacitorNodeJS.echoSend("echo-hello", "[]"); } catch (Throwable ignored) {}
                }
                try { lock.wait(Math.min(500, end - now)); } catch (InterruptedException e) { return false; }
            }
            return true;
        }
    }

    /** GET or POST on the server, on a background thread: a JSONObject, a JSONArray, or null. */
    static ListenableFuture<Object> call(String method, String path, @Nullable JSONObject body) {
        SettableFuture<Object> out = SettableFuture.create();
        io.execute(() -> {
            try { out.set(callNow(method, path, body)); } catch (Throwable e) { out.setException(e); }
        });
        return out;
    }

    /** Same, here (not on the main thread). */
    @Nullable
    static Object callNow(String method, String path, @Nullable JSONObject body) throws Exception {
        if (!await(30000)) throw new IllegalStateException("Écho's server isn't ready");
        HttpURLConnection c = (HttpURLConnection) new URL("http://127.0.0.1:" + port + path).openConnection();
        try {
            c.setRequestMethod(method);
            c.setConnectTimeout(5000);
            c.setReadTimeout(45000);
            c.setRequestProperty("x-echo-token", token);
            c.setRequestProperty("accept", "application/json");
            if (body != null) {
                c.setDoOutput(true);
                c.setRequestProperty("content-type", "application/json");
                try (OutputStream o = c.getOutputStream()) { o.write(body.toString().getBytes(StandardCharsets.UTF_8)); }
            }
            int code = c.getResponseCode();
            InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
            String text = in == null ? "" : read(in);
            Object value = text.isEmpty() ? null : new JSONTokener(text).nextValue();
            if (code >= 400) {
                String error = value instanceof JSONObject ? ((JSONObject) value).optString("error", "HTTP " + code) : "HTTP " + code;
                throw new ServerError(error, code);
            }
            return value == JSONObject.NULL ? null : value;
        } finally {
            c.disconnect();
        }
    }

    /** Bytes from the server (a cover). */
    @Nullable
    static byte[] bytes(String path) throws Exception {
        if (!await(15000)) return null;
        String sep = path.contains("?") ? "&" : "?";
        HttpURLConnection c = (HttpURLConnection) new URL("http://127.0.0.1:" + port + path + (mediaToken != null ? sep + "t=" + mediaToken : "")).openConnection();
        try {
            c.setConnectTimeout(5000);
            c.setReadTimeout(20000);
            c.setRequestProperty("x-echo-token", token);
            if (c.getResponseCode() != 200) return null;
            try (InputStream in = c.getInputStream()) { return readBytes(in, 12 * 1024 * 1024); }
        } finally {
            c.disconnect();
        }
    }

    static String read(InputStream in) throws Exception {
        return new String(readBytes(in, 32 * 1024 * 1024), StandardCharsets.UTF_8);
    }

    static byte[] readBytes(InputStream in, int max) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) {
            out.write(buf, 0, n);
            if (out.size() > max) throw new IllegalStateException("too large");
        }
        return out.toByteArray();
    }

    static final class ServerError extends Exception {
        final int status;
        ServerError(String message, int status) { super(message); this.status = status; }
    }
}
