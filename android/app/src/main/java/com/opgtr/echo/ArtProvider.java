package com.opgtr.echo;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.BitmapShader;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Shader;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.util.Base64;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.content.ContextCompat;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.List;

/**
 * Pictures for the car screen. Android Auto only shows content:// pictures,
 * so the covers Écho has (a song's own art, a cover on Deezer…) are served
 * from here, and the ones Écho draws too: a mix's rings (as in the app), a
 * playlist's 4 covers, the icons of "Lire", "Aléatoire", "Titres aimés"…
 *
 *   /t/<song id>        a library song's art (from Écho's server)
 *   /u/<base64 address> a cover on the web (known cover sites only)
 *   /r?s=&l=&c=         rings (seed, label, center picture)
 *   /m?c=a,b,c,d        4 covers in a square
 *   /i/<name>           an icon
 */
public class ArtProvider extends ContentProvider {
    private static final String TAG = "EchoArt";
    private static final int SIZE = 512;
    // Cover sites only: this is not a way for other apps to fetch any address.
    private static final String[] HOSTS = { "dzcdn.net", "deezer.com", "scdn.co", "tidal.com", "mzstatic.com", "googleusercontent.com", "ytimg.com", "qobuz.com", "coverartarchive.org", "archive.org" };

    @Override public boolean onCreate() { return true; }
    @Nullable @Override public String getType(@NonNull Uri uri) { return "image/png"; }
    @Nullable @Override public Cursor query(@NonNull Uri uri, @Nullable String[] p, @Nullable String s, @Nullable String[] a, @Nullable String o) { return null; }
    @Nullable @Override public Uri insert(@NonNull Uri uri, @Nullable ContentValues v) { return null; }
    @Override public int delete(@NonNull Uri uri, @Nullable String s, @Nullable String[] a) { return 0; }
    @Override public int update(@NonNull Uri uri, @Nullable ContentValues v, @Nullable String s, @Nullable String[] a) { return 0; }

    @Nullable
    @Override
    public ParcelFileDescriptor openFile(@NonNull Uri uri, @NonNull String mode) throws FileNotFoundException {
        if (!"r".equals(mode)) throw new FileNotFoundException("read only");
        Context ctx = getContext();
        if (ctx == null) throw new FileNotFoundException();
        File dir = new File(ctx.getCacheDir(), "car-art");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        File file = new File(dir, hash(uri.toString()) + ".png");
        if (!file.exists() || file.length() == 0) {
            Bitmap b = null;
            try { b = render(ctx, uri); } catch (Throwable e) { Log.w(TAG, uri + ": " + e.getMessage()); }
            if (b == null) throw new FileNotFoundException(uri.toString());
            File tmp = new File(dir, file.getName() + ".tmp");
            try (FileOutputStream out = new FileOutputStream(tmp)) {
                b.compress(Bitmap.CompressFormat.PNG, 100, out);
            } catch (Exception e) {
                throw new FileNotFoundException(e.getMessage());
            }
            //noinspection ResultOfMethodCallIgnored
            tmp.renameTo(file);
            trim(dir);
        }
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    // ------------------------------------------------------------ drawing
    @Nullable
    private static Bitmap render(Context ctx, Uri uri) throws Exception {
        List<String> seg = uri.getPathSegments();
        if (seg.isEmpty()) return null;
        switch (seg.get(0)) {
            case "t": return seg.size() > 1 ? square(fromRef(ctx, "t:" + seg.get(1)), SIZE) : null;
            case "u": return seg.size() > 1 ? square(fromRef(ctx, "u:" + seg.get(1)), SIZE) : null;
            case "i": return seg.size() > 1 ? icon(ctx, seg.get(1)) : null;
            case "r": return rings(ctx, uri.getQueryParameter("s"), uri.getQueryParameter("l"), uri.getQueryParameter("c"));
            case "m": return mosaic(ctx, uri.getQueryParameter("c"));
            default: return null;
        }
    }

    /** "t:<id>" (library art) or "u:<base64 address>" (a cover on the web). */
    @Nullable
    static Bitmap fromRef(Context ctx, @Nullable String ref) throws Exception {
        if (ref == null || ref.length() < 3) return null;
        byte[] data = null;
        if (ref.startsWith("t:")) {
            data = AutoLink.bytes("/api/art/" + Uri.encode(ref.substring(2)));
        } else if (ref.startsWith("u:")) {
            String address = new String(Base64.decode(ref.substring(2), Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP), StandardCharsets.UTF_8);
            data = fetch(address);
        }
        if (data == null) return null;
        BitmapFactory.Options o = new BitmapFactory.Options();
        o.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(data, 0, data.length, o);
        int sample = 1;
        while (o.outWidth / (sample * 2) >= SIZE && o.outHeight / (sample * 2) >= SIZE) sample *= 2;
        BitmapFactory.Options d = new BitmapFactory.Options();
        d.inSampleSize = sample;
        return BitmapFactory.decodeByteArray(data, 0, data.length, d);
    }

    @Nullable
    private static byte[] fetch(String address) throws Exception {
        Uri u = Uri.parse(address);
        if (!"https".equals(u.getScheme()) || u.getHost() == null) return null;
        String host = u.getHost().toLowerCase();
        boolean known = false;
        for (String h : HOSTS) if (host.equals(h) || host.endsWith("." + h)) { known = true; break; }
        if (!known) return null;
        HttpURLConnection c = (HttpURLConnection) new URL(address).openConnection();
        try {
            c.setConnectTimeout(8000);
            c.setReadTimeout(15000);
            c.setInstanceFollowRedirects(true);
            if (c.getResponseCode() != 200) return null;
            try (InputStream in = c.getInputStream()) { return AutoLink.readBytes(in, 12 * 1024 * 1024); }
        } finally {
            c.disconnect();
        }
    }

    /** Centered and cropped to a square of `size`. */
    @Nullable
    private static Bitmap square(@Nullable Bitmap src, int size) {
        if (src == null) return null;
        Bitmap out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(out);
        drawCover(c, src, new RectF(0, 0, size, size));
        return out;
    }

    private static void drawCover(Canvas c, Bitmap src, RectF box) {
        float scale = Math.max(box.width() / src.getWidth(), box.height() / src.getHeight());
        float w = src.getWidth() * scale, h = src.getHeight() * scale;
        Matrix m = new Matrix();
        m.setScale(scale, scale);
        m.postTranslate(box.left + (box.width() - w) / 2f, box.top + (box.height() - h) / 2f);
        c.save();
        c.clipRect(box);
        c.drawBitmap(src, m, new Paint(Paint.FILTER_BITMAP_FLAG | Paint.ANTI_ALIAS_FLAG));
        c.restore();
    }

    /** A playlist's 4 covers in a square (any missing: Écho's grey). */
    @Nullable
    private static Bitmap mosaic(Context ctx, @Nullable String list) throws Exception {
        if (list == null) return null;
        String[] refs = list.split(",");
        Bitmap out = Bitmap.createBitmap(SIZE, SIZE, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(out);
        c.drawColor(0xFF2A2A2A);
        int half = SIZE / 2;
        for (int i = 0; i < 4 && i < refs.length; i++) {
            Bitmap b = fromRef(ctx, refs[i]);
            if (b != null) drawCover(c, b, new RectF((i % 2) * half, (i / 2) * half, (i % 2) * half + half, (i / 2) * half + half));
        }
        return out;
    }

    // The app's Rings.jsx, same colors and same shapes for the same mix.
    private static final int[][] HUES = {
        { 0xFFF2C14E, 0xFF3A2F7A }, { 0xFF8FD3C7, 0xFF203A5C }, { 0xFFF09AB6, 0xFF41245E },
        { 0xFFB9A6FF, 0xFF2A2560 }, { 0xFF7FB7FF, 0xFF1D2E5E }, { 0xFFE8B27A, 0xFF4A2A3F },
    };

    /** FNV-1a over the text's characters, as Rings.jsx (one UTF-16 unit per code point). */
    static long hashOf(String text) {
        int h = 0x811C9DC5;
        for (int i = 0; i < text.length(); ) {
            int cp = text.codePointAt(i);
            h ^= Character.toChars(cp)[0];
            h *= 16777619;
            i += Character.charCount(cp);
        }
        return h & 0xFFFFFFFFL;
    }

    private static Bitmap rings(Context ctx, @Nullable String seed, @Nullable String label, @Nullable String center) throws Exception {
        long h = hashOf(seed == null ? "" : seed);
        int[] hue = HUES[(int) (h % HUES.length)];
        int ink = hue[0], ground = hue[1];
        int count = 7 + (int) (h % 4);
        int offset = (((int) h) >> 4) % 20 - 10;
        float k = SIZE / 100f;
        float cx = (50 + offset * 0.6f) * k, cy = (50 - offset * 0.3f) * k;
        Bitmap out = Bitmap.createBitmap(SIZE, SIZE, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(out);
        c.drawColor(ground);
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setStyle(Paint.Style.STROKE);
        p.setColor(ink);
        for (int i = 0; i < count; i++) {
            p.setStrokeWidth((i % 3 == 0 ? 2.4f : 1.1f) * k);
            p.setAlpha(Math.round(255 * Math.max(0.12f, 0.85f - i * 0.1f)));
            c.drawCircle(cx, cy, (19 + i * 10) * k, p);
        }
        Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
        fill.setColor(ink);
        c.drawCircle(cx, cy, 16.5f * k, fill);
        Bitmap pic = null;
        try { pic = fromRef(ctx, center); } catch (Exception ignored) {}
        if (pic != null) {
            Bitmap sq = square(pic, Math.round(30 * k));
            Paint shader = new Paint(Paint.ANTI_ALIAS_FLAG);
            BitmapShader s = new BitmapShader(sq, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP);
            Matrix m = new Matrix();
            m.setTranslate(cx - 15 * k, cy - 15 * k);
            s.setLocalMatrix(m);
            shader.setShader(s);
            c.drawCircle(cx, cy, 15 * k, shader);
        } else {
            fill.setColor(ground);
            c.drawCircle(cx, cy, 3 * k, fill);
        }
        if (label != null && !label.isEmpty()) {
            String text = label.length() > 22 ? label.substring(0, 21) + "…" : label;
            Paint t = new Paint(Paint.ANTI_ALIAS_FLAG);
            t.setColor(Color.WHITE);
            t.setTypeface(Typeface.create(Typeface.DEFAULT, Typeface.BOLD));
            t.setTextSize((label.length() > 14 ? 8 : 10) * k);
            t.setShadowLayer(4, 0, 1, 0x99000000);
            c.drawText(text, 8 * k, 92 * k, t);
        }
        return out;
    }

    /** Écho's orange icon on the car's dark grey. */
    @Nullable
    private static Bitmap icon(Context ctx, String name) {
        int res;
        switch (name) {
            case "play": res = R.drawable.ic_auto_play; break;
            case "shuffle": res = R.drawable.ic_auto_shuffle; break;
            case "heart": res = R.drawable.ic_auto_heart; break;
            case "phone": res = R.drawable.ic_auto_phone; break;
            case "album": res = R.drawable.ic_auto_album; break;
            case "artist": res = R.drawable.ic_auto_artist; break;
            case "recent": res = R.drawable.ic_auto_recent; break;
            case "follow": res = R.drawable.ic_auto_follow; break;
            default: res = R.drawable.ic_auto_list; break;
        }
        Drawable d = ContextCompat.getDrawable(ctx, res);
        if (d == null) return null;
        Bitmap out = Bitmap.createBitmap(SIZE, SIZE, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(out);
        c.drawColor(0xFF2A2A2A);
        int pad = SIZE * 28 / 100;
        d.setBounds(pad, pad, SIZE - pad, SIZE - pad);
        d.draw(c);
        return out;
    }

    // -------------------------------------------------------------- cache
    private static String hash(String s) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-1").digest(s.getBytes(StandardCharsets.UTF_8));
            StringBuilder b = new StringBuilder();
            for (byte x : d) b.append(String.format("%02x", x));
            return b.toString();
        } catch (Exception e) {
            return Integer.toHexString(s.hashCode());
        }
    }

    /** At most ~400 pictures are kept (the oldest go). */
    private static void trim(File dir) {
        File[] files = dir.listFiles();
        if (files == null || files.length <= 400) return;
        java.util.Arrays.sort(files, (a, b) -> Long.compare(a.lastModified(), b.lastModified()));
        for (int i = 0; i < files.length - 300; i++) //noinspection ResultOfMethodCallIgnored
            files[i].delete();
    }
}
