package com.opgtr.echo;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioManager;
import android.media.audiofx.DynamicsProcessing;
import android.media.audiofx.Equalizer;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.media3.cast.CastPlayer;
import androidx.media3.cast.SessionAvailabilityListener;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.DeviceInfo;
import androidx.media3.common.ForwardingPlayer;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.extractor.DefaultExtractorsFactory;
import androidx.media3.session.CommandButton;
import androidx.media3.session.LibraryResult;
import androidx.media3.session.MediaConstants;
import androidx.media3.session.MediaLibraryService;
import androidx.media3.session.MediaSession;
import androidx.media3.session.SessionCommand;
import androidx.media3.session.SessionCommands;
import androidx.media3.session.SessionResult;

import com.google.common.collect.ImmutableList;
import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.ListenableFuture;
import com.google.common.util.concurrent.SettableFuture;

import com.google.android.gms.cast.Cast;
import com.google.android.gms.cast.framework.CastContext;
import com.google.android.gms.cast.framework.CastSession;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Écho's player: ExoPlayer in a media session service. It plays in the
 * background, shows the media notification and lock-screen controls, answers
 * headset and Bluetooth buttons, and moves the music to a Chromecast or a
 * Google Nest (CastPlayer) and back.
 *
 * The app tells it what to play (the current song, and the next one when it's
 * already on the phone, so songs follow each other even if the app is asleep).
 * "Previous"/"next" from the notification go to the app, which knows the queue.
 *
 * It is also a media library (Android Auto, car screens, Bluetooth browsing):
 * the car lists Pour toi, Playlists and Bibliothèque (asked from Écho's
 * server, see server/auto.js and AutoLink), and what is picked there plays
 * here even when the app isn't open; the app follows when it is. The car's
 * buttons (♥, aléatoire, répéter, égaliseur) and steering-wheel controls drive
 * the same session.
 */
@UnstableApi
public class PlaybackService extends MediaLibraryService {
    private static final String TAG = "EchoPlayback";
    static PlaybackService instance;

    interface Listener {
        void onEvent(String name, JSONObject data);
    }

    static Listener listener;

    private ExoPlayer exo;
    private CastPlayer castPlayer;
    private Player active;
    private MediaLibrarySession session;
    // The queue as the app last described it, for car screens.
    private final List<Item> library = new ArrayList<>();
    static final String ROOT = "echo-root";
    // The car's buttons next to play/pause.
    static final String CMD_LIKE = "echo.like", CMD_SHUFFLE = "echo.shuffle", CMD_REPEAT = "echo.repeat", CMD_EQ = "echo.eq";
    private boolean likedNow = false;
    @Nullable private String likedId = null;
    private boolean shuffleOn = false;
    private int repeatMode = 0; // 0 off, 1 all, 2 this song
    private String eqName = "Désactivé";
    // What the car listed (for onGetItem) and its searches.
    private final Map<String, JSONObject> nodes = new ConcurrentHashMap<>();
    private final Map<String, List<MediaItem>> searches = new ConcurrentHashMap<>();
    // A queue started from the car while the app sleeps: all of it (repeat
    // all) and, while shuffled, its order before (shuffle off again).
    @Nullable private List<Item> carAll = null;
    @Nullable private List<Item> carOrder = null;
    private int audioSession = 0;
    private DynamicsProcessing dynamics;
    private Equalizer equalizer;
    private float[] eqBands = null;
    private float eqPreamp = 0f;
    private boolean eqEnabled = false;

    // What the app asked for, so it can move between phone and TV.
    private final List<Item> items = new ArrayList<>();
    private final Handler main = new Handler(Looper.getMainLooper());

    static class Item {
        String id, url, castUrl, mime, title, artist, album, artwork, castArtwork;
        @Nullable String quality; // "FLAC 24 bits · Basses+", shown in the car under the artist
        long durationMs;

        /** True when a TV / Google Nest can fetch it (Écho's Wi-Fi address, not 127.0.0.1). */
        boolean castable() { return castUrl != null && !castUrl.isEmpty(); }

        /** null for the TV when it can't be cast (see castable()). */
        @Nullable
        MediaItem toMediaItem(boolean forCast) {
            if (forCast && !castable()) return null;
            MediaMetadata.Builder meta = new MediaMetadata.Builder()
                .setTitle(title)
                .setArtist(artist)
                .setAlbumTitle(album)
                .setIsPlayable(true);
            String art = forCast ? castArtwork : artwork;
            if (art != null && !art.isEmpty()) meta.setArtworkUri(Uri.parse(art));
            if (quality != null && !quality.isEmpty()) {
                meta.setSubtitle(artist == null || artist.isEmpty() ? quality : artist + " · " + quality);
                meta.setDescription(quality);
            }
            MediaItem.Builder b = new MediaItem.Builder()
                .setMediaId(id == null ? "" : id)
                .setUri(forCast && castUrl != null ? castUrl : url)
                .setMediaMetadata(meta.build());
            // The Cast receiver needs a type: without one, CastPlayer threw and the app closed.
            if (mime != null) b.setMimeType(mime);
            else if (forCast) b.setMimeType("audio/flac");
            return b.build();
        }
    }

    // --------------------------------------------------------------- life
    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        audioSession = am != null ? am.generateAudioSessionId() : 0;
        // Files without a seek index (raw AAC, some MP3s) can still be
        // seeked: the karaoke lines and the progress bar rely on it.
        DefaultExtractorsFactory extractors = new DefaultExtractorsFactory()
            .setConstantBitrateSeekingEnabled(true)
            .setConstantBitrateSeekingAlwaysEnabled(true);
        // A song still downloading answers once it's ready (up to minutes):
        // the player waits for it instead of giving up after 8 seconds.
        DefaultHttpDataSource.Factory http = new DefaultHttpDataSource.Factory()
            .setConnectTimeoutMs(15000)
            .setReadTimeoutMs(6 * 60 * 1000)
            .setAllowCrossProtocolRedirects(true);
        exo = new ExoPlayer.Builder(this)
            .setMediaSourceFactory(new DefaultMediaSourceFactory(new DefaultDataSource.Factory(this, http), extractors))
            .setAudioAttributes(new AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), true)
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .build();
        if (audioSession != 0) exo.setAudioSessionId(audioSession);
        exo.addListener(playerListener);
        active = exo;

        Intent open = new Intent(this, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent activity = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        session = new MediaLibrarySession.Builder(this, new AppControlledPlayer(exo), libraryCallback).setSessionActivity(activity).build();
        applyEqualizer();
        session.setCustomLayout(buttons());
        // The car may start the player without the app: Écho's server too, then
        // the equalizer you chose (the app sets it itself when it's open).
        AutoLink.init(this);
        AutoLink.io.execute(this::loadEqualizer);

        try {
            CastContext cast = CastContext.getSharedInstance(this);
            castPlayer = new CastPlayer(cast);
            castPlayer.addListener(playerListener);
            castPlayer.setSessionAvailabilityListener(new SessionAvailabilityListener() {
                @Override public void onCastSessionAvailable() { switchTo(castPlayer); }
                @Override public void onCastSessionUnavailable() { switchTo(exo); }
            });
            if (castPlayer.isCastSessionAvailable()) switchTo(castPlayer);
        } catch (Exception e) {
            Log.w(TAG, "Cast unavailable: " + e.getMessage());
        }
    }

    @Nullable
    @Override
    public MediaLibrarySession onGetSession(@NonNull MediaSession.ControllerInfo controllerInfo) {
        return session;
    }

    @Override
    public void onTaskRemoved(@Nullable Intent rootIntent) {
        // Swiped away while paused: stop. While playing, the music goes on.
        if (active == null || !active.getPlayWhenReady() || active.getMediaItemCount() == 0) {
            stopSelf();
        }
    }

    @Override
    public void onDestroy() {
        instance = null;
        releaseEffects();
        if (session != null) { session.release(); session = null; }
        if (castPlayer != null) { castPlayer.setSessionAvailabilityListener(null); castPlayer.release(); castPlayer = null; }
        if (exo != null) { exo.release(); exo = null; }
        super.onDestroy();
    }

    // ------------------------------------------------------------ controls
    /** The notification's previous/next go to the app (it holds the queue). */
    @SuppressWarnings("deprecation")
    static final int[] VOLUME_COMMANDS = {
        Player.COMMAND_GET_DEVICE_VOLUME, Player.COMMAND_SET_DEVICE_VOLUME, Player.COMMAND_SET_DEVICE_VOLUME_WITH_FLAGS,
        Player.COMMAND_ADJUST_DEVICE_VOLUME, Player.COMMAND_ADJUST_DEVICE_VOLUME_WITH_FLAGS,
    };

    private final class AppControlledPlayer extends ForwardingPlayer {
        AppControlledPlayer(Player player) { super(player); }

        @NonNull
        @Override
        public Commands getAvailableCommands() {
            Commands.Builder b = super.getAvailableCommands().buildUpon()
                .add(COMMAND_SEEK_TO_NEXT).add(COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
                .add(COMMAND_SEEK_TO_PREVIOUS).add(COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM);
            if (remote()) b.addAll(VOLUME_COMMANDS);
            return b.build();
        }

        @Override
        public boolean isCommandAvailable(int command) {
            if (remote()) for (int c : VOLUME_COMMANDS) if (c == command) return true;
            return command == COMMAND_SEEK_TO_NEXT || command == COMMAND_SEEK_TO_NEXT_MEDIA_ITEM
                || command == COMMAND_SEEK_TO_PREVIOUS || command == COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM
                || super.isCommandAvailable(command);
        }

        private boolean remote() { return getWrappedPlayer() == castPlayer && castPlayer != null; }
        private int castVolume() { CastSession c = castSession(); return c == null ? 0 : (int) Math.round(c.getVolume() * CAST_STEPS); }

        @Override public void addListener(@NonNull Player.Listener l) { super.addListener(l); volumeListeners.add(l); }
        @Override public void removeListener(@NonNull Player.Listener l) { super.removeListener(l); volumeListeners.remove(l); }

        @NonNull
        @Override
        public DeviceInfo getDeviceInfo() {
            if (!remote()) return super.getDeviceInfo();
            return new DeviceInfo.Builder(DeviceInfo.PLAYBACK_TYPE_REMOTE).setMinVolume(0).setMaxVolume(CAST_STEPS).build();
        }
        @Override public int getDeviceVolume() { return remote() ? castVolume() : super.getDeviceVolume(); }
        @Override public boolean isDeviceMuted() { CastSession c = castSession(); return remote() ? c != null && c.isMute() : super.isDeviceMuted(); }
        @SuppressWarnings("deprecation") @Override public void setDeviceVolume(int volume) { if (remote()) setCastVolume(volume / (double) CAST_STEPS, null); else super.setDeviceVolume(volume); }
        @Override public void setDeviceVolume(int volume, int flags) { if (remote()) setCastVolume(volume / (double) CAST_STEPS, null); else super.setDeviceVolume(volume, flags); }
        @SuppressWarnings("deprecation") @Override public void increaseDeviceVolume() { if (remote()) setCastVolume((castVolume() + 1) / (double) CAST_STEPS, null); else super.increaseDeviceVolume(); }
        @Override public void increaseDeviceVolume(int flags) { if (remote()) setCastVolume((castVolume() + 1) / (double) CAST_STEPS, null); else super.increaseDeviceVolume(flags); }
        @SuppressWarnings("deprecation") @Override public void decreaseDeviceVolume() { if (remote()) setCastVolume((castVolume() - 1) / (double) CAST_STEPS, null); else super.decreaseDeviceVolume(); }
        @Override public void decreaseDeviceVolume(int flags) { if (remote()) setCastVolume((castVolume() - 1) / (double) CAST_STEPS, null); else super.decreaseDeviceVolume(flags); }
        @SuppressWarnings("deprecation") @Override public void setDeviceMuted(boolean muted) { if (remote()) setCastVolume(0, muted); else super.setDeviceMuted(muted); }
        @Override public void setDeviceMuted(boolean muted, int flags) { if (remote()) setCastVolume(0, muted); else super.setDeviceMuted(muted, flags); }

        @Override public void seekToNext() { goNext(); }
        @Override public void seekToNextMediaItem() { goNext(); }
        @Override public void seekToPrevious() { goPrevious(); }
        @Override public void seekToPreviousMediaItem() { goPrevious(); }

        private void goNext() {
            // The next song is already here: play it now, and tell the app.
            if (getWrappedPlayer().getMediaItemCount() > getWrappedPlayer().getCurrentMediaItemIndex() + 1) {
                getWrappedPlayer().seekToNextMediaItem();
                getWrappedPlayer().play();
            } else {
                emit("remote", json("action", "next"));
                // The app may be asleep (phone locked, in the car): if it
                // hasn't moved on shortly, play the next song that is here.
                final MediaItem from = getWrappedPlayer().getCurrentMediaItem();
                final String fromId = from != null ? from.mediaId : null;
                main.postDelayed(() -> {
                    if (active == null || fromId == null) return;
                    MediaItem now = active.getCurrentMediaItem();
                    if (now == null || !fromId.equals(now.mediaId)) return;
                    Item following = null;
                    boolean seen = false;
                    for (Item i : library) {
                        if (seen && i.url != null) { following = i; break; }
                        if (fromId.equals(i.id)) seen = true;
                    }
                    if (following == null) return;
                    load(following, null, 0, true);
                    emit("remote", jump(following.id));
                }, 2500);
            }
        }

        private void goPrevious() {
            if (getWrappedPlayer().getCurrentPosition() > 4000) { getWrappedPlayer().seekTo(0); return; }
            // The songs already played are kept here: going back works even
            // when the app is asleep (phone locked, in the car, steering-wheel
            // buttons). The app follows with "jump".
            Item back = history.isEmpty() ? null : history.remove(history.size() - 1);
            if (back == null) { emit("remote", json("action", "previous")); return; }
            boolean cast = active == castPlayer && castPlayer != null;
            MediaItem m = back.toMediaItem(cast);
            if (m == null) { history.add(back); emit("remote", json("action", "previous")); return; }
            try {
                getWrappedPlayer().addMediaItem(0, m);
                items.add(0, back);
                getWrappedPlayer().seekTo(0, 0);
                getWrappedPlayer().play();
                emit("remote", jump(back.id));
            } catch (RuntimeException e) { Log.w(TAG, "previous: " + e.getMessage()); emit("remote", json("action", "previous")); }
        }
    }

    private final Player.Listener playerListener = new Player.Listener() {
        @Override
        public void onEvents(@NonNull Player player, @NonNull Player.Events events) {
            if (player != active) return;
            if (events.containsAny(Player.EVENT_PLAYBACK_STATE_CHANGED, Player.EVENT_IS_PLAYING_CHANGED, Player.EVENT_PLAY_WHEN_READY_CHANGED)) {
                emit("state", status());
            }
        }

        @Override
        public void onPlaybackStateChanged(int state) {
            if (state == Player.STATE_ENDED && active != null && active.getMediaItemCount() > 0) {
                emit("ended", status());
                // Started from the car, the app asleep: "Répéter : tout" starts again.
                if (!appAlive() && repeatMode == 1 && carAll != null && !carAll.isEmpty()) main.post(() -> playCarQueue(new ArrayList<>(carAll), 0));
            }
        }

        @Override
        public void onMediaItemTransition(@Nullable MediaItem mediaItem, int reason) {
            if (mediaItem == null || active == null) return;
            refreshLiked(mediaItem.mediaId);
            main.post(PlaybackService.this::saveResume);
            if (reason != Player.MEDIA_ITEM_TRANSITION_REASON_AUTO && reason != Player.MEDIA_ITEM_TRANSITION_REASON_SEEK) return;
            if (active.getCurrentMediaItemIndex() <= 0) return;
            // Moved on to the song that was waiting: drop the finished one.
            final String id = mediaItem.mediaId;
            main.post(() -> {
                if (active == null) return;
                while (active.getCurrentMediaItemIndex() > 0) active.removeMediaItem(0);
                while (items.size() > 1 && !id.equals(items.get(0).id)) remember(items.remove(0));
                // The queue here is running low: the app adds more when it can.
            });
            emit("advanced", json("id", id));
        }

        @Override
        public void onPlayerError(@NonNull PlaybackException error) {
            JSONObject o = status();
            try { o.put("error", error.getMessage()); o.put("code", error.getErrorCodeName()); } catch (Exception ignored) {}
            emit("error", o);
        }
    };

    // -------------------------------------------------------------- queue
    /** The player's items, in order; on the TV, up to the first one it can't fetch. */
    static List<MediaItem> mediaItems(List<Item> from, boolean cast) {
        List<MediaItem> list = new ArrayList<>();
        for (Item i : from) {
            MediaItem m = i.toMediaItem(cast);
            if (m == null) break;
            list.add(m);
        }
        return list;
    }

    // ------------------------------------------------------------ history
    /** The songs played before this one, most recent last (for "previous" without the app). */
    private final List<Item> history = new ArrayList<>();
    private void remember(@Nullable Item played) {
        if (played == null || played.id == null) return;
        if (!history.isEmpty() && played.id.equals(history.get(history.size() - 1).id)) return;
        history.add(played);
        while (history.size() > 100) history.remove(0);
    }

    void load(Item current, @Nullable Item next, long positionMs, boolean play) {
        // A new song from the app: the one playing goes into the history,
        // unless the app is going back to the one before (then it leaves it).
        Item playing = items.isEmpty() ? null : items.get(0);
        if (playing != null && current.id != null && !current.id.equals(playing.id)) {
            Item last = history.isEmpty() ? null : history.get(history.size() - 1);
            if (last != null && current.id.equals(last.id)) history.remove(history.size() - 1);
            else remember(playing);
        }
        items.clear();
        items.add(current);
        if (next != null) items.add(next);
        boolean cast = active == castPlayer && castPlayer != null;
        List<MediaItem> list = mediaItems(items, cast);
        if (list.isEmpty()) { emit("cast", castStatus(true)); return; }
        try {
            active.setMediaItems(list, 0, Math.max(0, positionMs));
            active.prepare();
            active.setPlayWhenReady(play);
        } catch (RuntimeException e) { Log.w(TAG, "load: " + e.getMessage()); }
        // The app chose: its queue now, not one started in the car.
        carAll = null;
        carOrder = null;
        refreshLiked(current.id);
        saveResume();
    }

    /**
     * The songs after the current one (the app's queue, several ahead, those
     * still to download included): they follow each other here, even when
     * the app sleeps with the screen locked.
     */
    void setUpcoming(List<Item> next) {
        boolean cast = active == castPlayer && castPlayer != null;
        while (items.size() > 1) items.remove(items.size() - 1);
        int count = active.getMediaItemCount();
        int index = active.getCurrentMediaItemIndex();
        if (count > index + 1) active.removeMediaItems(index + 1, count);
        if (items.isEmpty() || next == null) return;
        items.addAll(next);
        List<MediaItem> list = mediaItems(next, cast);
        try { if (!list.isEmpty()) active.addMediaItems(list); } catch (RuntimeException e) { Log.w(TAG, "upcoming: " + e.getMessage()); }
        saveResume();
    }

    /** The song after the current one changed (or is now on the phone). */
    void setNext(@Nullable Item next) {
        boolean cast = active == castPlayer && castPlayer != null;
        while (items.size() > 1) items.remove(items.size() - 1);
        int count = active.getMediaItemCount();
        int index = active.getCurrentMediaItemIndex();
        if (count > index + 1) active.removeMediaItems(index + 1, count);
        if (next != null && !items.isEmpty()) {
            items.add(next);
            MediaItem m = next.toMediaItem(cast);
            try { if (m != null) active.addMediaItem(m); } catch (RuntimeException e) { Log.w(TAG, "next: " + e.getMessage()); }
        }
    }

    void play() { if (active != null) { if (active.getPlaybackState() == Player.STATE_IDLE) active.prepare(); active.play(); } }
    void pause() { if (active != null) active.pause(); }
    void seek(long ms) { if (active != null) active.seekTo(Math.max(0, ms)); }
    void stopPlayback() { if (active != null) { active.stop(); active.clearMediaItems(); } items.clear(); }

    JSONObject status() {
        JSONObject o = new JSONObject();
        try {
            Player p = active;
            o.put("playing", p != null && p.isPlaying());
            o.put("wants", p != null && p.getPlayWhenReady());
            o.put("buffering", p != null && p.getPlaybackState() == Player.STATE_BUFFERING);
            o.put("ended", p != null && p.getPlaybackState() == Player.STATE_ENDED);
            o.put("position", p != null ? p.getCurrentPosition() / 1000.0 : 0);
            long d = p != null ? p.getDuration() : C.TIME_UNSET;
            o.put("duration", d == C.TIME_UNSET ? 0 : d / 1000.0);
            MediaItem item = p != null ? p.getCurrentMediaItem() : null;
            o.put("id", item != null ? item.mediaId : null);
            o.put("casting", p != null && p == castPlayer);
        } catch (Exception ignored) {}
        return o;
    }

    // ----------------------------------------------------------- casting
    private void switchTo(Player target) {
        if (target == null || target == active) return;
        Player previous = active;
        long position = C.TIME_UNSET;
        boolean playing = false;
        if (previous != null) {
            position = previous.getCurrentPosition();
            playing = previous.getPlayWhenReady();
            previous.stop();
        }
        active = target;
        session.setPlayer(new AppControlledPlayer(target));
        boolean cast = target == castPlayer;
        // The song playing can't go to the TV as it is (a song still to
        // download, or the cast address not ready): the app reloads it.
        boolean reload = false;
        if (!items.isEmpty()) {
            List<MediaItem> list = mediaItems(items, cast);
            if (list.isEmpty()) reload = true;
            else {
                try {
                    target.setMediaItems(list, 0, position == C.TIME_UNSET ? 0 : position);
                    target.prepare();
                    target.setPlayWhenReady(playing);
                } catch (RuntimeException e) { Log.w(TAG, "switch: " + e.getMessage()); reload = true; }
            }
        }
        if (cast) watchCastVolume();
        JSONObject o = castStatus(reload);
        try { o.put("position", position == C.TIME_UNSET ? 0 : position / 1000.0); o.put("wants", playing); } catch (Exception ignored) {}
        emit("cast", o);
    }

    private JSONObject castStatus(boolean reload) {
        JSONObject o = status();
        try { o.put("casting", active != null && active == castPlayer); o.put("reload", reload); } catch (Exception ignored) {}
        return o;
    }

    // ------------------------------------------------- the TV's volume
    // The phone's volume buttons change the Google Nest / TV volume while
    // casting: the session tells Android the playback is remote, with this
    // volume (CastPlayer 1.5 doesn't).
    static final int CAST_STEPS = 20;
    private final List<Player.Listener> volumeListeners = new ArrayList<>();
    private CastSession watched;
    private final Cast.Listener castVolume = new Cast.Listener() {
        @Override public void onVolumeChanged() {
            CastSession c = castSession();
            if (c == null) return;
            int v = (int) Math.round(c.getVolume() * CAST_STEPS);
            boolean m = c.isMute();
            for (Player.Listener l : new ArrayList<>(volumeListeners)) l.onDeviceVolumeChanged(v, m);
        }
    };

    @Nullable
    CastSession castSession() {
        try { return CastContext.getSharedInstance(this).getSessionManager().getCurrentCastSession(); } catch (Exception e) { return null; }
    }

    private void watchCastVolume() {
        CastSession c = castSession();
        if (c == null || c == watched) return;
        try { if (watched != null) watched.removeCastListener(castVolume); } catch (Exception ignored) {}
        watched = c;
        try { c.addCastListener(castVolume); } catch (Exception ignored) {}
    }

    void setCastVolume(double v, @Nullable Boolean mute) {
        CastSession c = castSession();
        if (c == null) return;
        try {
            if (mute != null) c.setMute(mute);
            else c.setVolume(Math.max(0, Math.min(1, v)));
        } catch (Exception e) { Log.w(TAG, "cast volume: " + e.getMessage()); }
    }

    boolean isCasting() { return active != null && active == castPlayer; }

    // --------------------------------------------------------- equalizer
    static final int[] BAND_HZ = {32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000};

    void setEqualizer(boolean enabled, float[] bands, float preamp) {
        eqEnabled = enabled;
        eqBands = bands;
        eqPreamp = preamp;
        applyEqualizer();
    }

    private void applyEqualizer() {
        if (audioSession == 0) return;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                if (dynamics == null) {
                    DynamicsProcessing.Config config = new DynamicsProcessing.Config.Builder(
                        DynamicsProcessing.VARIANT_FAVOR_FREQUENCY_RESOLUTION, 2,
                        true, BAND_HZ.length, false, 0, false, 0, false).build();
                    dynamics = new DynamicsProcessing(0, audioSession, config);
                }
                for (int ch = 0; ch < 2; ch++) {
                    DynamicsProcessing.Eq eq = dynamics.getPreEqByChannelIndex(ch);
                    for (int b = 0; b < BAND_HZ.length; b++) {
                        DynamicsProcessing.EqBand band = eq.getBand(b);
                        // Each band covers up to halfway to the next one.
                        float cutoff = b + 1 < BAND_HZ.length ? (float) Math.sqrt(BAND_HZ[b] * (double) BAND_HZ[b + 1]) : 20000f;
                        band.setCutoffFrequency(cutoff);
                        band.setGain(eqEnabled && eqBands != null && b < eqBands.length ? eqBands[b] : 0f);
                        band.setEnabled(true);
                        eq.setBand(b, band);
                    }
                    eq.setEnabled(true);
                    dynamics.setPreEqByChannelIndex(ch, eq);
                    dynamics.setInputGainbyChannel(ch, eqEnabled ? eqPreamp : 0f);
                }
                dynamics.setEnabled(eqEnabled);
            } else {
                if (equalizer == null) equalizer = new Equalizer(0, audioSession);
                short count = equalizer.getNumberOfBands();
                short[] range = equalizer.getBandLevelRange();
                for (short b = 0; b < count; b++) {
                    int center = equalizer.getCenterFreq(b) / 1000;
                    float gain = 0f;
                    if (eqEnabled && eqBands != null) {
                        int nearest = 0;
                        for (int i = 1; i < BAND_HZ.length; i++) if (Math.abs(BAND_HZ[i] - center) < Math.abs(BAND_HZ[nearest] - center)) nearest = i;
                        gain = eqBands[nearest] + eqPreamp;
                    }
                    short level = (short) Math.max(range[0], Math.min(range[1], Math.round(gain * 100)));
                    equalizer.setBandLevel(b, level);
                }
                equalizer.setEnabled(eqEnabled);
            }
        } catch (Exception e) {
            Log.w(TAG, "Equalizer: " + e.getMessage());
        }
    }

    private void releaseEffects() {
        try { if (dynamics != null) dynamics.release(); } catch (Exception ignored) {}
        try { if (equalizer != null) equalizer.release(); } catch (Exception ignored) {}
        dynamics = null;
        equalizer = null;
    }


    // ------------------------------------------------------------ library
    /** The songs coming next (from the app): found again when the car asks for one of them. */
    void setLibrary(List<Item> list) {
        library.clear();
        library.addAll(list);
    }

    /** Is Écho's window there to follow (and to decide the queue)? */
    private static boolean appAlive() { return listener != null; }

    private MediaItem browsable(String id, String title) {
        return new MediaItem.Builder().setMediaId(id).setMediaMetadata(new MediaMetadata.Builder()
            .setTitle(title).setIsBrowsable(true).setIsPlayable(false)
            .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED).build()).build();
    }

    private Item find(String id) {
        for (Item i : library) if (i.id != null && i.id.equals(id)) return i;
        for (Item i : items) if (i.id != null && i.id.equals(id)) return i;
        return null;
    }

    /** A row of the car screen, from server/auto.js. */
    private MediaItem toItem(JSONObject n) {
        String id = n.optString("id", "");
        boolean folder = n.optBoolean("browsable", false);
        MediaMetadata.Builder m = new MediaMetadata.Builder()
            .setTitle(n.optString("title", ""))
            .setIsBrowsable(folder)
            .setIsPlayable(n.optBoolean("playable", false))
            .setMediaType(folder ? MediaMetadata.MEDIA_TYPE_FOLDER_MIXED : MediaMetadata.MEDIA_TYPE_MUSIC);
        String sub = n.optString("subtitle", "");
        if (!sub.isEmpty()) m.setSubtitle(sub);
        if (!folder && !n.optBoolean("action", false) && !sub.isEmpty()) m.setArtist(sub);
        String album = n.optString("album", "");
        if (!album.isEmpty()) m.setAlbumTitle(album);
        String art = n.isNull("art") ? "" : n.optString("art", "");
        if (!art.isEmpty()) m.setArtworkUri(Uri.parse(art));
        Bundle extras = new Bundle();
        String group = n.optString("group", "");
        if (!group.isEmpty()) extras.putString(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_GROUP_TITLE, group);
        // ↓ next to the songs already on the phone.
        if (n.optBoolean("downloaded", false)) extras.putLong(MediaConstants.EXTRAS_KEY_DOWNLOAD_STATUS, 2 /* downloaded */);
        if (folder) {
            String style = n.optString("style", "list");
            extras.putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_BROWSABLE, "grid".equals(style) ? MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_GRID_ITEM : MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM);
            extras.putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_PLAYABLE, MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM);
        }
        m.setExtras(extras);
        nodes.put(id, n);
        return new MediaItem.Builder().setMediaId(id).setMediaMetadata(m.build()).build();
    }

    private List<MediaItem> toItems(@Nullable Object value) {
        List<MediaItem> out = new ArrayList<>();
        if (!(value instanceof JSONArray)) return out;
        JSONArray a = (JSONArray) value;
        for (int i = 0; i < a.length(); i++) {
            JSONObject n = a.optJSONObject(i);
            if (n != null && !n.optString("id", "").isEmpty()) out.add(toItem(n));
        }
        return out;
    }

    /** A row that only says something (Écho not answering…). */
    private static MediaItem note(String title, String subtitle) {
        return new MediaItem.Builder().setMediaId("note|" + title).setMediaMetadata(new MediaMetadata.Builder()
            .setTitle(title).setSubtitle(subtitle).setIsBrowsable(false).setIsPlayable(false)
            .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC).build()).build();
    }

    private static ImmutableList<MediaItem> slice(List<MediaItem> all, int page, int pageSize) {
        int size = Math.max(1, pageSize);
        int from = Math.max(0, page * size);
        if (from >= all.size()) return ImmutableList.of();
        return ImmutableList.copyOf(all.subList(from, Math.min(all.size(), from + size)));
    }

    /** One of Écho's songs, as the server describes it for the player. */
    @Nullable
    private static Item itemOf(@Nullable JSONObject o) {
        if (o == null) return null;
        Item i = new Item();
        i.id = o.optString("id", "");
        i.url = o.optString("url", "");
        i.title = o.optString("title", "");
        i.artist = o.optString("artist", "");
        i.album = o.optString("album", "");
        i.artwork = o.isNull("artwork") ? null : o.optString("artwork", null);
        i.quality = o.optString("quality", "");
        i.durationMs = (long) (o.optDouble("duration", 0) * 1000);
        return i.url.isEmpty() ? null : i;
    }

    /**
     * A queue from the car (or the voice): it plays here at once, the app
     * follows when it's open ("car": its songs and where in them).
     */
    private MediaSession.MediaItemsWithStartPosition startCarQueue(JSONObject r, long positionMs) {
        List<Item> list = new ArrayList<>();
        JSONArray a = r.optJSONArray("items");
        if (a != null) for (int k = 0; k < a.length(); k++) { Item i = itemOf(a.optJSONObject(k)); if (i != null) list.add(i); }
        Item playing = items.isEmpty() ? null : items.get(0);
        if (playing != null && (list.isEmpty() || !list.get(0).id.equals(playing.id))) remember(playing);
        items.clear();
        items.addAll(list);
        carAll = new ArrayList<>(list);
        carOrder = null;
        shuffleOn = r.optBoolean("shuffle", false);
        JSONObject e = new JSONObject();
        try {
            e.put("action", "car");
            e.put("songs", r.optJSONArray("songs"));
            e.put("index", r.optInt("index", 0));
            e.put("context", r.optString("context", "list"));
            e.put("shuffle", shuffleOn);
        } catch (Exception ignored) {}
        emit("remote", e);
        if (!list.isEmpty()) refreshLiked(list.get(0).id);
        updateButtons();
        saveResume();
        return new MediaSession.MediaItemsWithStartPosition(mediaItems(items, false), 0, Math.max(0, positionMs));
    }

    /** The same queue again from its start (repeat all without the app). */
    private void playCarQueue(List<Item> list, long positionMs) {
        if (active == null || list.isEmpty()) return;
        items.clear();
        items.addAll(list);
        try {
            active.setMediaItems(mediaItems(items, false), 0, positionMs);
            active.prepare();
            active.play();
        } catch (RuntimeException e) { Log.w(TAG, "car queue: " + e.getMessage()); }
    }

    private final MediaLibrarySession.Callback libraryCallback = new MediaLibrarySession.Callback() {
        @NonNull
        @Override
        public MediaSession.ConnectionResult onConnect(@NonNull MediaSession s, @NonNull MediaSession.ControllerInfo controller) {
            SessionCommands.Builder commands = MediaSession.ConnectionResult.DEFAULT_SESSION_AND_LIBRARY_COMMANDS.buildUpon();
            for (String c : new String[] { CMD_LIKE, CMD_SHUFFLE, CMD_REPEAT, CMD_EQ }) commands.add(new SessionCommand(c, Bundle.EMPTY));
            return new MediaSession.ConnectionResult.AcceptedResultBuilder(s)
                .setAvailableSessionCommands(commands.build())
                .setCustomLayout(buttons())
                .build();
        }

        @NonNull
        @Override
        public ListenableFuture<SessionResult> onCustomCommand(@NonNull MediaSession s, @NonNull MediaSession.ControllerInfo controller, @NonNull SessionCommand command, @NonNull Bundle args) {
            switch (command.customAction) {
                case CMD_LIKE: toggleLike(); break;
                case CMD_SHUFFLE: if (appAlive()) emit("remote", json("action", "shuffle")); else shuffleHere(); break;
                case CMD_REPEAT: if (appAlive()) emit("remote", json("action", "repeat")); else repeatHere(); break;
                case CMD_EQ: nextEqualizer(); break;
                default: return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_ERROR_NOT_SUPPORTED));
            }
            return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_SUCCESS));
        }

        @NonNull
        @Override
        public ListenableFuture<LibraryResult<MediaItem>> onGetLibraryRoot(@NonNull MediaLibrarySession s, @NonNull MediaSession.ControllerInfo browser, @Nullable LibraryParams params) {
            AutoLink.init(PlaybackService.this);
            // Covers in a grid (mixes, playlists), songs in a list.
            Bundle extras = new Bundle();
            extras.putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_BROWSABLE, MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_GRID_ITEM);
            extras.putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_PLAYABLE, MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM);
            LibraryParams out = new LibraryParams.Builder().setExtras(extras).build();
            return Futures.immediateFuture(LibraryResult.ofItem(browsable(ROOT, "Écho"), out));
        }

        @NonNull
        @Override
        public ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> onGetChildren(@NonNull MediaLibrarySession s, @NonNull MediaSession.ControllerInfo browser, @NonNull String parentId, int page, int pageSize, @Nullable LibraryParams params) {
            String id = ROOT.equals(parentId) ? "root" : parentId;
            SettableFuture<LibraryResult<ImmutableList<MediaItem>>> out = SettableFuture.create();
            AutoLink.io.execute(() -> {
                List<MediaItem> list;
                try {
                    list = toItems(AutoLink.callNow("GET", "/api/auto/children?id=" + Uri.encode(id), null));
                } catch (Exception e) {
                    Log.w(TAG, "car list " + id + ": " + e.getMessage());
                    list = new ArrayList<>();
                    list.add(AutoLink.connected()
                        ? note("Écho n’a pas pu afficher ceci", e.getMessage() == null ? "Réessaie dans un instant" : e.getMessage())
                        : note("Écho démarre…", "Réessaie dans un instant"));
                }
                out.set(LibraryResult.ofItemList(slice(list, page, pageSize), params));
            });
            return out;
        }

        @NonNull
        @Override
        public ListenableFuture<LibraryResult<MediaItem>> onGetItem(@NonNull MediaLibrarySession s, @NonNull MediaSession.ControllerInfo browser, @NonNull String mediaId) {
            JSONObject n = nodes.get(mediaId);
            if (n != null) return Futures.immediateFuture(LibraryResult.ofItem(toItem(n), null));
            Item i = find(mediaId);
            if (i == null) return Futures.immediateFuture(LibraryResult.ofError(LibraryResult.RESULT_ERROR_BAD_VALUE));
            return Futures.immediateFuture(LibraryResult.ofItem(i.toMediaItem(false), null));
        }

        /** The car's search (the magnifier, or typed when parked). */
        @NonNull
        @Override
        public ListenableFuture<LibraryResult<Void>> onSearch(@NonNull MediaLibrarySession s, @NonNull MediaSession.ControllerInfo browser, @NonNull String query, @Nullable LibraryParams params) {
            AutoLink.io.execute(() -> {
                List<MediaItem> list = searchNow(query);
                main.post(() -> { if (session != null) session.notifySearchResultChanged(browser, query, list.size(), params); });
            });
            return Futures.immediateFuture(LibraryResult.ofVoid());
        }

        @NonNull
        @Override
        public ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> onGetSearchResult(@NonNull MediaLibrarySession s, @NonNull MediaSession.ControllerInfo browser, @NonNull String query, int page, int pageSize, @Nullable LibraryParams params) {
            List<MediaItem> done = searches.get(query);
            if (done != null) return Futures.immediateFuture(LibraryResult.ofItemList(slice(done, page, pageSize), params));
            SettableFuture<LibraryResult<ImmutableList<MediaItem>>> out = SettableFuture.create();
            AutoLink.io.execute(() -> out.set(LibraryResult.ofItemList(slice(searchNow(query), page, pageSize), params)));
            return out;
        }

        /**
         * Something picked in the car, or said ("Mets du Stromae"): the server
         * gives the queue, it plays here, the app follows.
         */
        @NonNull
        @Override
        public ListenableFuture<MediaSession.MediaItemsWithStartPosition> onSetMediaItems(@NonNull MediaSession s, @NonNull MediaSession.ControllerInfo controller, @NonNull List<MediaItem> mediaItems, int startIndex, long startPositionMs) {
            MediaItem first = mediaItems.isEmpty() ? null : mediaItems.get(0);
            JSONObject body = new JSONObject();
            try {
                String id = first != null ? first.mediaId : "";
                CharSequence said = first != null ? first.requestMetadata.searchQuery : null;
                if (id != null && !id.isEmpty()) body.put("id", id);
                else body.put("query", said == null ? "" : said.toString());
            } catch (Exception ignored) {}
            SettableFuture<MediaSession.MediaItemsWithStartPosition> out = SettableFuture.create();
            AutoLink.io.execute(() -> {
                try {
                    Object r = AutoLink.callNow("POST", "/api/auto/play", body);
                    if (!(r instanceof JSONObject)) throw new IllegalStateException("nothing to play");
                    main.post(() -> {
                        try { out.set(startCarQueue((JSONObject) r, 0)); } catch (Exception e) { out.setException(e); }
                    });
                } catch (Exception e) {
                    Log.w(TAG, "car play: " + e.getMessage());
                    out.setException(e);
                }
            });
            return out;
        }

        /** A song from the list the app gave (old car screens, Bluetooth browsing). */
        @NonNull
        @Override
        public ListenableFuture<List<MediaItem>> onAddMediaItems(@NonNull MediaSession s, @NonNull MediaSession.ControllerInfo controller, @NonNull List<MediaItem> mediaItems) {
            List<MediaItem> out = new ArrayList<>();
            for (MediaItem m : mediaItems) {
                Item i = find(m.mediaId);
                if (i == null) continue;
                MediaItem forPlayer = i.toMediaItem(isCasting());
                out.add(forPlayer != null ? forPlayer : i.toMediaItem(false));
                items.clear();
                items.add(i);
                emit("remote", jump(i.id));
            }
            return Futures.immediateFuture(out);
        }

        /**
         * Play pressed in the car with nothing loaded (or the car starting the
         * music by itself): what was playing, where it was.
         */
        @NonNull
        @Override
        public ListenableFuture<MediaSession.MediaItemsWithStartPosition> onPlaybackResumption(@NonNull MediaSession s, @NonNull MediaSession.ControllerInfo controller) {
            if (!items.isEmpty()) {
                List<MediaItem> list = new ArrayList<>();
                for (Item i : items) list.add(i.toMediaItem(false));
                return Futures.immediateFuture(new MediaSession.MediaItemsWithStartPosition(list, 0, C.TIME_UNSET));
            }
            SettableFuture<MediaSession.MediaItemsWithStartPosition> out = SettableFuture.create();
            AutoLink.io.execute(() -> {
                try {
                    JSONObject saved = readResume();
                    if (saved == null) throw new IllegalStateException("nothing played yet");
                    long position = saved.optLong("position", 0);
                    Object r = AutoLink.callNow("POST", "/api/auto/resume", saved);
                    if (!(r instanceof JSONObject)) throw new IllegalStateException("nothing to resume");
                    main.post(() -> {
                        try { out.set(startCarQueue((JSONObject) r, position)); } catch (Exception e) { out.setException(e); }
                    });
                } catch (Exception e) {
                    Log.w(TAG, "resume: " + e.getMessage());
                    if (!library.isEmpty()) out.set(new MediaSession.MediaItemsWithStartPosition(Collections.singletonList(library.get(0).toMediaItem(false)), 0, C.TIME_UNSET));
                    else out.setException(e);
                }
            });
            return out;
        }
    };

    private List<MediaItem> searchNow(String query) {
        List<MediaItem> list;
        try {
            list = toItems(AutoLink.callNow("GET", "/api/auto/search?q=" + Uri.encode(query), null));
        } catch (Exception e) {
            Log.w(TAG, "car search: " + e.getMessage());
            list = new ArrayList<>();
        }
        if (searches.size() > 20) searches.clear();
        searches.put(query, list);
        return list;
    }

    // ------------------------------------------------- the car's buttons
    private List<CommandButton> buttons() {
        List<CommandButton> b = new ArrayList<>();
        b.add(new CommandButton.Builder(likedNow ? CommandButton.ICON_HEART_FILLED : CommandButton.ICON_HEART_UNFILLED)
            .setDisplayName(likedNow ? "Retirer des titres aimés" : "J’aime")
            .setSessionCommand(new SessionCommand(CMD_LIKE, Bundle.EMPTY)).build());
        b.add(new CommandButton.Builder(shuffleOn ? CommandButton.ICON_SHUFFLE_ON : CommandButton.ICON_SHUFFLE_OFF)
            .setDisplayName(shuffleOn ? "Aléatoire : oui" : "Aléatoire : non")
            .setSessionCommand(new SessionCommand(CMD_SHUFFLE, Bundle.EMPTY)).build());
        b.add(new CommandButton.Builder(repeatMode == 2 ? CommandButton.ICON_REPEAT_ONE : repeatMode == 1 ? CommandButton.ICON_REPEAT_ALL : CommandButton.ICON_REPEAT_OFF)
            .setDisplayName(repeatMode == 2 ? "Répéter : ce titre" : repeatMode == 1 ? "Répéter : tout" : "Répéter : non")
            .setSessionCommand(new SessionCommand(CMD_REPEAT, Bundle.EMPTY)).build());
        b.add(new CommandButton.Builder(CommandButton.ICON_UNDEFINED)
            .setCustomIconResId(R.drawable.ic_cmd_eq)
            .setDisplayName("Égaliseur : " + eqName)
            .setSessionCommand(new SessionCommand(CMD_EQ, Bundle.EMPTY)).build());
        return b;
    }

    private void updateButtons() {
        main.post(() -> { if (session != null) session.setCustomLayout(buttons()); });
    }

    /** The app's own shuffle, repeat and ♥ (changed on the phone, or after the car asked). */
    void setModes(@Nullable Boolean shuffle, @Nullable String repeat, @Nullable String likeId, @Nullable Boolean liked) {
        if (shuffle != null) shuffleOn = shuffle;
        if (repeat != null) {
            repeatMode = "one".equals(repeat) ? 2 : "all".equals(repeat) ? 1 : 0;
            // The app repeats by itself.
            if (exo != null) exo.setRepeatMode(Player.REPEAT_MODE_OFF);
        }
        if (likeId != null && liked != null) { likedId = likeId; likedNow = liked; }
        updateButtons();
    }

    /** ♥ of the song playing (asked to the server when the song changes). */
    private void refreshLiked(@Nullable String id) {
        if (id == null || id.isEmpty() || id.startsWith("d:")) {
            if (likedNow) { likedNow = false; likedId = id; updateButtons(); }
            return;
        }
        AutoLink.io.execute(() -> {
            try {
                Object r = AutoLink.callNow("GET", "/api/tracks/" + Uri.encode(id), null);
                boolean liked = r instanceof JSONObject && ((JSONObject) r).optInt("liked", 0) == 1;
                main.post(() -> {
                    MediaItem now = active != null ? active.getCurrentMediaItem() : null;
                    if (now == null || !id.equals(now.mediaId)) return;
                    likedId = id;
                    if (liked != likedNow) { likedNow = liked; updateButtons(); }
                });
            } catch (Exception e) { Log.w(TAG, "liked: " + e.getMessage()); }
        });
    }

    private void toggleLike() {
        MediaItem now = active != null ? active.getCurrentMediaItem() : null;
        if (now == null || now.mediaId.isEmpty() || now.mediaId.startsWith("d:")) return;
        String id = now.mediaId;
        boolean want = !(likedNow && id.equals(likedId));
        likedId = id;
        likedNow = want;
        updateButtons();
        AutoLink.io.execute(() -> {
            try {
                AutoLink.callNow("POST", "/api/tracks/" + Uri.encode(id) + "/like", json("liked", want));
                JSONObject ev = new JSONObject();
                ev.put("action", "liked"); ev.put("id", id); ev.put("liked", want);
                emit("remote", ev);
                main.post(() -> { if (session != null) { session.notifyChildrenChanged("lists", 0, null); session.notifyChildrenChanged("liked", 0, null); } });
            } catch (Exception e) {
                Log.w(TAG, "like: " + e.getMessage());
                main.post(() -> { if (id.equals(likedId)) { likedNow = !want; updateButtons(); } });
            }
        });
    }

    /** Aléatoire with the app asleep: the songs after this one, mixed (or back in order). */
    private void shuffleHere() {
        if (active == null) return;
        shuffleOn = !shuffleOn;
        if (items.size() > 1) {
            List<Item> rest = new ArrayList<>(items.subList(1, items.size()));
            List<Item> next;
            if (shuffleOn) {
                carOrder = new ArrayList<>(rest);
                next = new ArrayList<>(rest);
                Collections.shuffle(next);
            } else if (carOrder != null) {
                next = new ArrayList<>();
                for (Item i : carOrder) if (rest.contains(i)) next.add(i);
                carOrder = null;
            } else next = rest;
            setUpcoming(next);
        }
        updateButtons();
    }

    /** Répéter with the app asleep: non → tout → ce titre. */
    private void repeatHere() {
        repeatMode = (repeatMode + 1) % 3;
        if (exo != null) exo.setRepeatMode(repeatMode == 2 ? Player.REPEAT_MODE_ONE : Player.REPEAT_MODE_OFF);
        updateButtons();
    }

    /** The equalizer button: the next preset, kept in your preferences, the app told. */
    private void nextEqualizer() {
        AutoLink.io.execute(() -> {
            try {
                Object r = AutoLink.callNow("POST", "/api/auto/eq/next", new JSONObject());
                if (r instanceof JSONObject) applyServerEqualizer((JSONObject) r);
                emit("prefs", new JSONObject());
            } catch (Exception e) { Log.w(TAG, "eq: " + e.getMessage()); }
        });
    }

    /** At start: the equalizer you chose (the app does it when it's open). */
    private void loadEqualizer() {
        try {
            Object r = AutoLink.callNow("GET", "/api/auto/eq", null);
            if (r instanceof JSONObject) {
                JSONObject o = (JSONObject) r;
                if (appAlive()) { eqName = o.optString("name", eqName); updateButtons(); }
                else applyServerEqualizer(o);
            }
        } catch (Exception e) { Log.w(TAG, "eq at start: " + e.getMessage()); }
    }

    private void applyServerEqualizer(JSONObject r) {
        JSONObject eq = r.optJSONObject("eq");
        String name = r.optString("name", "Désactivé");
        main.post(() -> {
            eqName = name;
            if (eq != null) {
                JSONArray bands = eq.optJSONArray("bands");
                float[] b = new float[BAND_HZ.length];
                for (int i = 0; bands != null && i < b.length && i < bands.length(); i++) b[i] = (float) bands.optDouble(i, 0);
                setEqualizer(eq.optBoolean("enabled", false), b, (float) eq.optDouble("preamp", 0));
            }
            updateButtons();
        });
    }

    // ------------------------------------------- what was playing, kept
    /** The queue (its songs, not their addresses: those change) and the position, for the next start. */
    private void saveResume() {
        if (items.isEmpty() || active == null) return;
        JSONArray songs = new JSONArray();
        try {
            for (int k = 0; k < items.size() && k < 300; k++) {
                Item i = items.get(k);
                if (i.id == null || i.id.isEmpty()) continue;
                JSONObject o = new JSONObject();
                if (i.id.startsWith("d:")) {
                    o.put("deezer_id", i.id.substring(2));
                    o.put("title", i.title); o.put("artist", i.artist); o.put("album", i.album);
                    o.put("duration", i.durationMs / 1000.0);
                } else o.put("local_id", i.id);
                songs.put(o);
            }
            JSONObject out = new JSONObject();
            out.put("songs", songs);
            out.put("index", 0);
            out.put("position", Math.max(0, active.getCurrentPosition()));
            byte[] data = out.toString().getBytes(StandardCharsets.UTF_8);
            File file = new File(getFilesDir(), "car-resume.json");
            AutoLink.io.execute(() -> {
                try (FileOutputStream f = new FileOutputStream(file)) { f.write(data); } catch (Exception e) { Log.w(TAG, "resume save: " + e.getMessage()); }
            });
        } catch (Exception e) { Log.w(TAG, "resume: " + e.getMessage()); }
    }

    @Nullable
    private JSONObject readResume() {
        File file = new File(getFilesDir(), "car-resume.json");
        if (!file.exists()) return null;
        try (FileInputStream in = new FileInputStream(file)) {
            return new JSONObject(AutoLink.read(in));
        } catch (Exception e) { return null; }
    }

    private static JSONObject jump(String id) {
        JSONObject o = new JSONObject();
        try { o.put("action", "jump"); o.put("id", id); } catch (Exception ignored) {}
        return o;
    }

    // ------------------------------------------------------------ events
    static JSONObject json(String key, Object value) {
        JSONObject o = new JSONObject();
        try { o.put(key, value); } catch (Exception ignored) {}
        return o;
    }

    void emit(String name, JSONObject data) {
        Listener l = listener;
        if (l != null) main.post(() -> l.onEvent(name, data));
    }

}
