package com.opgtr.echo;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioManager;
import android.media.audiofx.DynamicsProcessing;
import android.media.audiofx.Equalizer;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.media3.cast.CastPlayer;
import androidx.media3.cast.SessionAvailabilityListener;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.ForwardingPlayer;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.extractor.DefaultExtractorsFactory;
import androidx.media3.session.LibraryResult;
import androidx.media3.session.MediaLibraryService;
import androidx.media3.session.MediaSession;

import com.google.common.collect.ImmutableList;
import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.ListenableFuture;

import com.google.android.gms.cast.framework.CastContext;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

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
 * the songs coming next, as the app last described them, can be browsed and
 * picked from the car; the car's buttons and steering-wheel controls drive the
 * same session.
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
    static final String ROOT = "echo-root", QUEUE = "echo-queue";
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
        long durationMs;

        MediaItem toMediaItem(boolean forCast) {
            MediaMetadata.Builder meta = new MediaMetadata.Builder()
                .setTitle(title)
                .setArtist(artist)
                .setAlbumTitle(album)
                .setIsPlayable(true);
            String art = forCast ? castArtwork : artwork;
            if (art != null && !art.isEmpty()) meta.setArtworkUri(Uri.parse(art));
            MediaItem.Builder b = new MediaItem.Builder()
                .setMediaId(id == null ? "" : id)
                .setUri(forCast && castUrl != null ? castUrl : url)
                .setMediaMetadata(meta.build());
            if (mime != null) b.setMimeType(mime);
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
        exo = new ExoPlayer.Builder(this)
            .setMediaSourceFactory(new DefaultMediaSourceFactory(this, extractors))
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
    private final class AppControlledPlayer extends ForwardingPlayer {
        AppControlledPlayer(Player player) { super(player); }

        @NonNull
        @Override
        public Commands getAvailableCommands() {
            return super.getAvailableCommands().buildUpon()
                .add(COMMAND_SEEK_TO_NEXT).add(COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
                .add(COMMAND_SEEK_TO_PREVIOUS).add(COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
                .build();
        }

        @Override
        public boolean isCommandAvailable(int command) {
            return command == COMMAND_SEEK_TO_NEXT || command == COMMAND_SEEK_TO_NEXT_MEDIA_ITEM
                || command == COMMAND_SEEK_TO_PREVIOUS || command == COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM
                || super.isCommandAvailable(command);
        }

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
            if (getWrappedPlayer().getCurrentPosition() > 4000) getWrappedPlayer().seekTo(0);
            else emit("remote", json("action", "previous"));
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
            if (state == Player.STATE_ENDED && active != null && active.getMediaItemCount() > 0) emit("ended", status());
        }

        @Override
        public void onMediaItemTransition(@Nullable MediaItem mediaItem, int reason) {
            if (mediaItem == null || active == null) return;
            if (reason != Player.MEDIA_ITEM_TRANSITION_REASON_AUTO && reason != Player.MEDIA_ITEM_TRANSITION_REASON_SEEK) return;
            if (active.getCurrentMediaItemIndex() <= 0) return;
            // Moved on to the song that was waiting: drop the finished one.
            final String id = mediaItem.mediaId;
            main.post(() -> {
                if (active == null) return;
                while (active.getCurrentMediaItemIndex() > 0) active.removeMediaItem(0);
                while (items.size() > 1 && !id.equals(items.get(0).id)) items.remove(0);
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
    void load(Item current, @Nullable Item next, long positionMs, boolean play) {
        items.clear();
        items.add(current);
        if (next != null) items.add(next);
        boolean cast = active == castPlayer && castPlayer != null;
        List<MediaItem> list = new ArrayList<>();
        for (Item i : items) list.add(i.toMediaItem(cast));
        active.setMediaItems(list, 0, Math.max(0, positionMs));
        active.prepare();
        active.setPlayWhenReady(play);
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
            active.addMediaItem(next.toMediaItem(cast));
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
        if (!items.isEmpty()) {
            boolean cast = target == castPlayer;
            List<MediaItem> list = new ArrayList<>();
            for (Item i : items) list.add(i.toMediaItem(cast));
            target.setMediaItems(list, 0, position == C.TIME_UNSET ? 0 : position);
            target.prepare();
            target.setPlayWhenReady(playing);
        }
        JSONObject o = status();
        try { o.put("casting", target == castPlayer); } catch (Exception ignored) {}
        emit("cast", o);
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
    /** The songs coming next (from the app): what a car screen can browse. */
    void setLibrary(List<Item> list) {
        library.clear();
        library.addAll(list);
        if (session != null) session.notifyChildrenChanged(QUEUE, library.size(), null);
    }

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

    private final MediaLibrarySession.Callback libraryCallback = new MediaLibrarySession.Callback() {
        @NonNull
        @Override
        public ListenableFuture<LibraryResult<MediaItem>> onGetLibraryRoot(@NonNull MediaLibrarySession s, @NonNull MediaSession.ControllerInfo browser, @Nullable LibraryParams params) {
            return Futures.immediateFuture(LibraryResult.ofItem(browsable(ROOT, "Écho"), params));
        }

        @NonNull
        @Override
        public ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> onGetChildren(@NonNull MediaLibrarySession s, @NonNull MediaSession.ControllerInfo browser, @NonNull String parentId, int page, int pageSize, @Nullable LibraryParams params) {
            List<MediaItem> out = new ArrayList<>();
            if (ROOT.equals(parentId)) out.add(browsable(QUEUE, "À suivre"));
            else if (QUEUE.equals(parentId)) for (Item i : library) out.add(i.toMediaItem(false));
            int from = Math.max(0, page * Math.max(1, pageSize));
            List<MediaItem> slice = from >= out.size() ? Collections.emptyList() : out.subList(from, Math.min(out.size(), from + Math.max(1, pageSize)));
            return Futures.immediateFuture(LibraryResult.ofItemList(ImmutableList.copyOf(slice), params));
        }

        @NonNull
        @Override
        public ListenableFuture<LibraryResult<MediaItem>> onGetItem(@NonNull MediaLibrarySession s, @NonNull MediaSession.ControllerInfo browser, @NonNull String mediaId) {
            Item i = find(mediaId);
            if (i == null) return Futures.immediateFuture(LibraryResult.ofError(LibraryResult.RESULT_ERROR_BAD_VALUE));
            return Futures.immediateFuture(LibraryResult.ofItem(i.toMediaItem(false), null));
        }

        /** A song picked on the car screen: it plays here, and the app follows. */
        @NonNull
        @Override
        public ListenableFuture<List<MediaItem>> onAddMediaItems(@NonNull MediaSession s, @NonNull MediaSession.ControllerInfo controller, @NonNull List<MediaItem> mediaItems) {
            List<MediaItem> out = new ArrayList<>();
            for (MediaItem m : mediaItems) {
                Item i = find(m.mediaId);
                if (i == null) continue;
                out.add(i.toMediaItem(isCasting()));
                items.clear();
                items.add(i);
                emit("remote", jump(i.id));
            }
            return Futures.immediateFuture(out);
        }

        /** Play pressed in the car with nothing loaded: the last song again. */
        @NonNull
        @Override
        public ListenableFuture<MediaSession.MediaItemsWithStartPosition> onPlaybackResumption(@NonNull MediaSession s, @NonNull MediaSession.ControllerInfo controller) {
            List<MediaItem> list = new ArrayList<>();
            for (Item i : items) list.add(i.toMediaItem(false));
            if (list.isEmpty() && !library.isEmpty()) list.add(library.get(0).toMediaItem(false));
            return Futures.immediateFuture(new MediaSession.MediaItemsWithStartPosition(list, 0, C.TIME_UNSET));
        }
    };

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
