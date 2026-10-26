package com.opgtr.echo;

import android.content.ComponentName;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;

import androidx.media3.session.MediaController;
import androidx.media3.session.SessionToken;
import androidx.mediarouter.media.MediaRouteSelector;
import androidx.mediarouter.media.MediaRouter;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.cast.CastMediaControlIntent;
import com.google.android.gms.cast.framework.CastContext;
import com.google.common.util.concurrent.ListenableFuture;
import com.google.common.util.concurrent.MoreExecutors;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * The app's side of the player (PlaybackService): what to play, the controls,
 * the equalizer, and the devices to cast to. Events come back as "player"
 * ({ type: state | ended | advanced | remote | error | cast, ... }).
 */
@CapacitorPlugin(name = "EchoPlayer")
public class EchoPlayerPlugin extends Plugin {
    private final Handler main = new Handler(Looper.getMainLooper());
    private ListenableFuture<MediaController> controllerFuture;
    private MediaController controller;
    private final List<Runnable> waiting = new ArrayList<>();
    private MediaRouter router;
    private MediaRouteSelector selector;
    private final MediaRouter.Callback routerCallback = new MediaRouter.Callback() {
        @Override public void onRouteAdded(MediaRouter r, MediaRouter.RouteInfo route) { devicesChanged(); }
        @Override public void onRouteRemoved(MediaRouter r, MediaRouter.RouteInfo route) { devicesChanged(); }
        @Override public void onRouteChanged(MediaRouter r, MediaRouter.RouteInfo route) { devicesChanged(); }
        @Override public void onRouteSelected(MediaRouter r, MediaRouter.RouteInfo route, int reason) { devicesChanged(); }
        @Override public void onRouteUnselected(MediaRouter r, MediaRouter.RouteInfo route, int reason) { devicesChanged(); }
    };

    @Override
    public void load() {
        PlaybackService.listener = (name, data) -> {
            JSObject out = new JSObject();
            try {
                JSONArray keys = data.names();
                if (keys != null) for (int i = 0; i < keys.length(); i++) out.put(keys.getString(i), data.get(keys.getString(i)));
            } catch (Exception ignored) {}
            out.put("type", name);
            notifyListeners("player", out);
        };
        main.post(() -> {
            try {
                CastContext.getSharedInstance(getContext());
                router = MediaRouter.getInstance(getContext());
                selector = new MediaRouteSelector.Builder()
                    .addControlCategory(CastMediaControlIntent.categoryForCast(CastMediaControlIntent.DEFAULT_MEDIA_RECEIVER_APPLICATION_ID))
                    .build();
            } catch (Exception ignored) {}
        });
    }

    /** Runs `job` on the main thread once the service is up. */
    private void withService(PluginCall call, ServiceJob job) {
        main.post(() -> {
            Runnable run = () -> {
                PlaybackService s = PlaybackService.instance;
                if (s == null) { call.reject("player not ready"); return; }
                try { job.run(s); } catch (Exception e) { call.reject(e.getMessage()); }
            };
            if (PlaybackService.instance != null) { run.run(); return; }
            waiting.add(run);
            if (controllerFuture == null) {
                SessionToken token = new SessionToken(getContext(), new ComponentName(getContext(), PlaybackService.class));
                controllerFuture = new MediaController.Builder(getContext(), token).buildAsync();
                controllerFuture.addListener(() -> {
                    try { controller = controllerFuture.get(); } catch (Exception ignored) {}
                    List<Runnable> jobs = new ArrayList<>(waiting);
                    waiting.clear();
                    for (Runnable r : jobs) r.run();
                }, MoreExecutors.directExecutor());
            }
        });
    }

    interface ServiceJob { void run(PlaybackService s) throws Exception; }

    private static PlaybackService.Item item(JSONObject o) {
        if (o == null) return null;
        PlaybackService.Item i = new PlaybackService.Item();
        i.id = o.optString("id", "");
        i.url = o.optString("url", null);
        i.castUrl = o.optString("castUrl", null);
        i.mime = o.optString("mime", null);
        i.title = o.optString("title", "");
        i.artist = o.optString("artist", "");
        i.album = o.optString("album", "");
        i.artwork = o.optString("artwork", null);
        i.castArtwork = o.optString("castArtwork", null);
        i.durationMs = (long) (o.optDouble("duration", 0) * 1000);
        if (i.url == null || i.url.isEmpty()) return null;
        return i;
    }

    @PluginMethod
    public void load(PluginCall call) {
        PlaybackService.Item current = item(call.getObject("item"));
        PlaybackService.Item next = item(call.getObject("next"));
        if (current == null) { call.reject("nothing to play"); return; }
        long position = (long) (call.getDouble("position", 0.0) * 1000);
        boolean play = Boolean.TRUE.equals(call.getBoolean("play", true));
        withService(call, s -> { s.load(current, next, position, play); call.resolve(); });
    }

    @PluginMethod
    public void setNext(PluginCall call) {
        PlaybackService.Item next = item(call.getObject("next"));
        withService(call, s -> { s.setNext(next); call.resolve(); });
    }

    /** The songs coming next, for car screens (Android Auto, Bluetooth browsing). */
    @PluginMethod
    public void setLibrary(PluginCall call) {
        List<PlaybackService.Item> list = new ArrayList<>();
        try {
            JSArray arr = call.getArray("items");
            if (arr != null) for (int k = 0; k < arr.length() && k < 100; k++) {
                PlaybackService.Item it = item(arr.getJSONObject(k));
                if (it != null) list.add(it);
            }
        } catch (Exception ignored) {}
        withService(call, s -> { s.setLibrary(list); call.resolve(); });
    }

    /** The next songs, in order (several ahead). */
    @PluginMethod
    public void setUpcoming(PluginCall call) {
        List<PlaybackService.Item> list = new ArrayList<>();
        try {
            JSArray arr = call.getArray("items");
            if (arr != null) for (int k = 0; k < arr.length() && k < 300; k++) {
                PlaybackService.Item it = item(arr.getJSONObject(k));
                if (it != null) list.add(it);
            }
        } catch (Exception ignored) {}
        withService(call, s -> { s.setUpcoming(list); call.resolve(); });
    }

    /** Shuffle, repeat and ♥ as the app has them: the car's buttons show the same. */
    @PluginMethod
    public void setModes(PluginCall call) {
        Boolean shuffle = call.getBoolean("shuffle");
        String repeat = call.getString("repeat");
        String likeId = call.getString("likedId");
        Boolean liked = call.getBoolean("liked");
        withService(call, s -> { s.setModes(shuffle, repeat, likeId, liked); call.resolve(); });
    }

    @PluginMethod public void play(PluginCall call) { withService(call, s -> { s.play(); call.resolve(); }); }
    @PluginMethod public void pause(PluginCall call) { withService(call, s -> { s.pause(); call.resolve(); }); }
    @PluginMethod public void stop(PluginCall call) { withService(call, s -> { s.stopPlayback(); call.resolve(); }); }

    @PluginMethod
    public void seek(PluginCall call) {
        long ms = (long) (call.getDouble("position", 0.0) * 1000);
        withService(call, s -> { s.seek(ms); call.resolve(); });
    }

    @PluginMethod
    public void status(PluginCall call) {
        main.post(() -> {
            PlaybackService s = PlaybackService.instance;
            if (s == null) { JSObject o = new JSObject(); o.put("playing", false); o.put("position", 0); o.put("duration", 0); call.resolve(o); return; }
            call.resolve(toJS(s.status()));
        });
    }

    @PluginMethod
    public void setEqualizer(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        float preamp = call.getFloat("preamp", 0f);
        float[] bands = new float[PlaybackService.BAND_HZ.length];
        try {
            JSArray list = call.getArray("bands");
            if (list != null) for (int i = 0; i < bands.length && i < list.length(); i++) bands[i] = (float) list.getDouble(i);
        } catch (Exception ignored) {}
        withService(call, s -> { s.setEqualizer(enabled, bands, preamp); call.resolve(); });
    }

    // ------------------------------------------------------------ casting
    @PluginMethod
    public void castScan(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", true));
        main.post(() -> {
            if (router == null || selector == null) { call.reject("Cast unavailable on this phone"); return; }
            router.removeCallback(routerCallback);
            if (on) router.addCallback(selector, routerCallback, MediaRouter.CALLBACK_FLAG_PERFORM_ACTIVE_SCAN);
            JSObject out = new JSObject();
            out.put("devices", devices());
            call.resolve(out);
        });
    }

    @PluginMethod
    public void castDevices(PluginCall call) {
        main.post(() -> { JSObject out = new JSObject(); out.put("devices", devices()); call.resolve(out); });
    }

    @PluginMethod
    public void castConnect(PluginCall call) {
        String id = call.getString("id");
        main.post(() -> {
            if (router == null) { call.reject("Cast unavailable"); return; }
            // Make sure the service runs, so it switches to the TV.
            withService(call, s -> {
                for (MediaRouter.RouteInfo r : router.getRoutes()) {
                    if (r.getId().equals(id)) { router.selectRoute(r); call.resolve(); return; }
                }
                call.reject("device not found");
            });
        });
    }

    @PluginMethod
    public void castDisconnect(PluginCall call) {
        main.post(() -> {
            try { CastContext.getSharedInstance(getContext()).getSessionManager().endCurrentSession(true); } catch (Exception ignored) {}
            if (router != null) router.unselect(MediaRouter.UNSELECT_REASON_STOPPED);
            call.resolve();
        });
    }

    private JSArray devices() {
        JSArray list = new JSArray();
        if (router == null || selector == null) return list;
        for (MediaRouter.RouteInfo r : router.getRoutes()) {
            if (r.isDefault() || !r.matchesSelector(selector) || !r.isEnabled()) continue;
            JSObject o = new JSObject();
            o.put("id", r.getId());
            o.put("name", r.getName());
            o.put("description", r.getDescription() == null ? "" : r.getDescription());
            o.put("selected", r.isSelected());
            o.put("connecting", r.getConnectionState() == MediaRouter.RouteInfo.CONNECTION_STATE_CONNECTING);
            o.put("kind", r.getDeviceType() == MediaRouter.RouteInfo.DEVICE_TYPE_TV ? "tv" : r.getDeviceType() == MediaRouter.RouteInfo.DEVICE_TYPE_SPEAKER ? "speaker" : "other");
            list.put(o);
        }
        return list;
    }

    private void devicesChanged() {
        JSObject out = new JSObject();
        out.put("type", "devices");
        out.put("devices", devices());
        notifyListeners("player", out);
    }

    private static JSObject toJS(JSONObject o) {
        JSObject out = new JSObject();
        try {
            JSONArray keys = o.names();
            if (keys != null) for (int i = 0; i < keys.length(); i++) out.put(keys.getString(i), o.get(keys.getString(i)));
        } catch (Exception ignored) {}
        return out;
    }

    @Override
    protected void handleOnDestroy() {
        // No window to follow the car any more: the player decides alone.
        PlaybackService.listener = null;
        if (router != null) router.removeCallback(routerCallback);
        if (controllerFuture != null) MediaController.releaseFuture(controllerFuture);
        super.handleOnDestroy();
    }
}
