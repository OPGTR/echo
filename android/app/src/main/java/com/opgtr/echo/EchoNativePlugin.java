package com.opgtr.echo;

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.DocumentsContract;
import android.provider.Settings;

import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;

/**
 * What the Écho interface needs from Android: access to the music files,
 * a folder picker that gives a real path (Écho's server reads files by path),
 * opening links in the browser, restarting.
 */
@CapacitorPlugin(
    name = "EchoNative",
    permissions = {
        @Permission(alias = "audio", strings = { Manifest.permission.READ_MEDIA_AUDIO, Manifest.permission.READ_MEDIA_IMAGES }),
        @Permission(alias = "storage", strings = { Manifest.permission.READ_EXTERNAL_STORAGE }),
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class EchoNativePlugin extends Plugin {

    private boolean hasMediaAccess() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return granted(Manifest.permission.READ_MEDIA_AUDIO);
        }
        return granted(Manifest.permission.READ_EXTERNAL_STORAGE);
    }

    private boolean granted(String permission) {
        return ContextCompat.checkSelfPermission(getContext(), permission) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasAllFilesAccess() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) return Environment.isExternalStorageManager();
        return granted(Manifest.permission.WRITE_EXTERNAL_STORAGE);
    }

    private JSObject accessState() {
        JSObject result = new JSObject();
        result.put("media", hasMediaAccess());
        result.put("allFiles", hasAllFilesAccess());
        result.put("sdk", Build.VERSION.SDK_INT);
        result.put("musicDir", Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MUSIC).getAbsolutePath());
        return result;
    }

    /** Downloads queued: keep the app awake until they're done (screen locked included). */
    @PluginMethod
    public void keepDownloading(PluginCall call) {
        Integer port = call.getInt("port");
        String token = call.getString("token");
        if (port == null || port <= 0) { call.reject("port"); return; }
        DownloadService.start(getContext(), port, token);
        call.resolve();
    }

    @PluginMethod
    public void storageAccess(PluginCall call) {
        call.resolve(accessState());
    }

    @PluginMethod
    public void requestMediaAccess(PluginCall call) {
        if (hasMediaAccess()) {
            call.resolve(accessState());
            return;
        }
        String alias = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU ? "audio" : "storage";
        requestPermissionForAlias(alias, call, "onMediaAccess");
    }

    @PermissionCallback
    private void onMediaAccess(PluginCall call) {
        // Android 13+: also ask to show the playback notification (media
        // notifications work without it, but some phones hide them).
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "onNotifications");
            return;
        }
        call.resolve(accessState());
    }

    @PermissionCallback
    private void onNotifications(PluginCall call) {
        call.resolve(accessState());
    }

    /** "All files access": needed to edit tags or delete songs, not to play them. */
    @PluginMethod
    public void requestAllFilesAccess(PluginCall call) {
        if (hasAllFilesAccess()) {
            call.resolve(accessState());
            return;
        }
        Intent intent;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            intent = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:" + getContext().getPackageName()));
        } else {
            intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()));
        }
        try {
            startActivityForResult(call, intent, "onAllFilesAccess");
        } catch (ActivityNotFoundException e) {
            try {
                startActivityForResult(call, new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION), "onAllFilesAccess");
            } catch (ActivityNotFoundException again) {
                call.reject("This phone has no setting for all-files access");
            }
        }
    }

    @ActivityCallback
    private void onAllFilesAccess(PluginCall call, ActivityResult result) {
        if (call != null) call.resolve(accessState());
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    /** The system folder picker, answered with a filesystem path. */
    @PluginMethod
    public void pickFolder(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            File music = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MUSIC);
            Uri initial = DocumentsContract.buildDocumentUri("com.android.externalstorage.documents", "primary:" + music.getName());
            intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI, initial);
        }
        try {
            startActivityForResult(call, intent, "onFolderPicked");
        } catch (ActivityNotFoundException e) {
            call.reject("No folder picker on this phone");
        }
    }

    @ActivityCallback
    private void onFolderPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != android.app.Activity.RESULT_OK || data == null || data.getData() == null) {
            JSObject none = new JSObject();
            none.put("path", null);
            call.resolve(none);
            return;
        }
        String path = treeUriToPath(data.getData());
        if (path == null) {
            call.reject("This folder can't be used: choose a folder in the phone's storage or on the SD card.");
            return;
        }
        JSObject picked = new JSObject();
        picked.put("path", path);
        call.resolve(picked);
    }

    /**
     * content://com.android.externalstorage.documents/tree/primary%3AMusic%2FRock
     *   -> /storage/emulated/0/Music/Rock
     * content://.../tree/1234-ABCD%3AMusic -> /storage/1234-ABCD/Music
     */
    static String treeUriToPath(Uri uri) {
        String docId;
        try {
            docId = DocumentsContract.getTreeDocumentId(uri);
        } catch (IllegalArgumentException e) {
            return null;
        }
        if (docId == null) return null;
        String authority = uri.getAuthority();
        if ("com.android.providers.downloads.documents".equals(authority)) {
            if (docId.startsWith("raw:")) return docId.substring(4);
            return Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS).getAbsolutePath();
        }
        if (!"com.android.externalstorage.documents".equals(authority)) return null;
        int colon = docId.indexOf(':');
        String volume = colon >= 0 ? docId.substring(0, colon) : docId;
        String relative = colon >= 0 ? docId.substring(colon + 1) : "";
        String base;
        if ("primary".equalsIgnoreCase(volume)) {
            base = Environment.getExternalStorageDirectory().getAbsolutePath();
        } else if ("home".equalsIgnoreCase(volume)) {
            base = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS).getAbsolutePath();
        } else {
            base = "/storage/" + volume;
        }
        String path = relative.isEmpty() ? base : base + "/" + relative;
        while (path.endsWith("/") && path.length() > 1) path = path.substring(0, path.length() - 1);
        return path;
    }

    /** A SpotiFLAC addon's verification page, in its own window (AddonAuthActivity). */
    @PluginMethod
    public void addonAuth(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !url.startsWith("https://")) {
            call.reject("No verification page");
            return;
        }
        Intent intent = new Intent(getContext(), AddonAuthActivity.class);
        intent.putExtra(AddonAuthActivity.EXTRA_URL, url);
        intent.putExtra(AddonAuthActivity.EXTRA_CALLBACK, call.getString("callback"));
        java.util.ArrayList<String> domains = new java.util.ArrayList<>();
        try {
            com.getcapacitor.JSArray list = call.getArray("domains");
            if (list != null) for (Object d : list.toList()) domains.add(String.valueOf(d));
        } catch (org.json.JSONException ignored) {}
        intent.putStringArrayListExtra(AddonAuthActivity.EXTRA_DOMAINS, domains);
        startActivityForResult(call, intent, "onAddonAuth");
    }

    @ActivityCallback
    private void onAddonAuth(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject out = new JSObject();
        Intent data = result.getData();
        if (result.getResultCode() == android.app.Activity.RESULT_OK && data != null) {
            out.put("url", data.getStringExtra(AddonAuthActivity.RESULT_URL));
            try {
                out.put("cookies", new com.getcapacitor.JSArray(data.getStringExtra(AddonAuthActivity.RESULT_COOKIES)));
            } catch (org.json.JSONException e) {
                out.put("cookies", new com.getcapacitor.JSArray());
            }
        } else {
            out.put("url", null);
            out.put("cookies", new com.getcapacitor.JSArray());
        }
        call.resolve(out);
    }

    /**
     * Where Écho may put music: the shared Music folder (other apps see it)
     * and Écho's own media folder (always writable, also indexed by Android).
     */
    @PluginMethod
    public void storagePaths(PluginCall call) {
        JSObject out = new JSObject();
        out.put("musicDir", Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MUSIC).getAbsolutePath());
        File[] media = getContext().getExternalMediaDirs();
        if (media != null && media.length > 0 && media[0] != null) out.put("mediaDir", media[0].getAbsolutePath());
        out.put("sdk", Build.VERSION.SDK_INT);
        call.resolve(out);
    }

    /** Tells Android about new files so other music apps see them at once. */
    @PluginMethod
    public void scanFiles(PluginCall call) {
        try {
            com.getcapacitor.JSArray list = call.getArray("paths");
            java.util.List<String> paths = list == null ? new java.util.ArrayList<>() : list.toList();
            if (!paths.isEmpty()) android.media.MediaScannerConnection.scanFile(getContext(), paths.toArray(new String[0]), null, null);
        } catch (org.json.JSONException ignored) {}
        call.resolve();
    }

    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !(url.startsWith("http://") || url.startsWith("https://") || url.startsWith("mailto:"))) {
            call.reject("Unsupported link");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("No app can open this link");
        }
    }

    @PluginMethod
    public void appInfo(PluginCall call) {
        JSObject info = new JSObject();
        try {
            PackageInfo pkg = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            info.put("version", pkg.versionName);
            info.put("build", Build.VERSION.SDK_INT >= 28 ? pkg.getLongVersionCode() : pkg.versionCode);
        } catch (PackageManager.NameNotFoundException ignored) {}
        info.put("sdk", Build.VERSION.SDK_INT);
        info.put("abi", Build.SUPPORTED_ABIS.length > 0 ? Build.SUPPORTED_ABIS[0] : "arm64-v8a");
        call.resolve(info);
    }

    // ------------------------------------------------------- Material You
    /** The phone's wallpaper colors (Android 12+), for the Material You theme. */
    @PluginMethod
    public void dynamicColors(PluginCall call) {
        JSObject out = new JSObject();
        if (Build.VERSION.SDK_INT < 31) { out.put("available", false); call.resolve(out); return; }
        android.content.res.Resources r = getContext().getResources();
        int[][] ids = {
            {android.R.color.system_accent1_100, android.R.color.system_accent1_200, android.R.color.system_accent1_300, android.R.color.system_accent1_500, android.R.color.system_accent1_800},
            {android.R.color.system_accent2_200, android.R.color.system_accent2_700, android.R.color.system_accent2_800},
            {android.R.color.system_neutral1_50, android.R.color.system_neutral1_200, android.R.color.system_neutral1_700, android.R.color.system_neutral1_800, android.R.color.system_neutral1_900},
        };
        String[][] names = {{"a100", "a200", "a300", "a500", "a800"}, {"b200", "b700", "b800"}, {"n50", "n200", "n700", "n800", "n900"}};
        for (int g = 0; g < ids.length; g++) for (int i = 0; i < ids[g].length; i++) {
            out.put(names[g][i], String.format("#%06X", 0xFFFFFF & r.getColor(ids[g][i], null)));
        }
        out.put("available", true);
        call.resolve(out);
    }

    // ------------------------------------------------------------ icons
    private static final String[] ICONS = {"Default", "Luce", "Glass"};

    /** Switches the launcher icon between Écho's built-in ones. */
    @PluginMethod
    public void setIcon(PluginCall call) {
        String name = call.getString("name", "Default");
        PackageManager pm = getContext().getPackageManager();
        String pkg = getContext().getPackageName();
        for (String icon : ICONS) {
            ComponentName c = new ComponentName(pkg, pkg + ".Icon" + icon);
            pm.setComponentEnabledSetting(c, icon.equals(name) ? PackageManager.COMPONENT_ENABLED_STATE_ENABLED : PackageManager.COMPONENT_ENABLED_STATE_DISABLED, PackageManager.DONT_KILL_APP);
        }
        call.resolve();
    }

    /**
     * The start screen in the theme you chose: Android 13+ remembers it for
     * the next launch; the window behind the app takes its color at once.
     */
    @PluginMethod
    public void setSplashTheme(PluginCall call) {
        String name = call.getString("name", "indigo");
        getContext().getSharedPreferences("echo", android.content.Context.MODE_PRIVATE).edit().putString("theme", name).apply();
        getActivity().runOnUiThread(() -> {
            try {
                if (Build.VERSION.SDK_INT >= 33) {
                    int style = "luce".equals(name) ? R.style.SplashLuce : "glass".equals(name) ? R.style.SplashGlass : R.style.AppTheme_NoActionBarLaunch;
                    getActivity().getSplashScreen().setSplashScreenTheme(style);
                }
                MainActivity.paintWindow(getActivity(), name);
            } catch (Exception ignored) {}
            call.resolve();
        });
    }

    /** Puts a shortcut with your own picture on the home screen (it opens Écho). */
    @PluginMethod
    public void pinShortcut(PluginCall call) {
        String data = call.getString("image");
        String label = call.getString("label", "Écho");
        if (data == null) { call.reject("no image"); return; }
        try {
            String b64 = data.contains(",") ? data.substring(data.indexOf(',') + 1) : data;
            byte[] bytes = android.util.Base64.decode(b64, android.util.Base64.DEFAULT);
            android.graphics.Bitmap src = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
            if (src == null) { call.reject("not an image"); return; }
            // Adaptive icons show the middle 66 %: the picture fills that, centred.
            int size = 432;
            android.graphics.Bitmap canvasBmp = android.graphics.Bitmap.createBitmap(size, size, android.graphics.Bitmap.Config.ARGB_8888);
            android.graphics.Canvas canvas = new android.graphics.Canvas(canvasBmp);
            int side = Math.min(src.getWidth(), src.getHeight());
            android.graphics.Rect from = new android.graphics.Rect((src.getWidth() - side) / 2, (src.getHeight() - side) / 2, (src.getWidth() + side) / 2, (src.getHeight() + side) / 2);
            canvas.drawBitmap(src, from, new android.graphics.Rect(0, 0, size, size), new android.graphics.Paint(android.graphics.Paint.FILTER_BITMAP_FLAG));
            Intent open = new Intent(getContext(), MainActivity.class).setAction(Intent.ACTION_MAIN);
            androidx.core.content.pm.ShortcutInfoCompat info = new androidx.core.content.pm.ShortcutInfoCompat.Builder(getContext(), "echo-custom-" + System.currentTimeMillis())
                .setShortLabel(label)
                .setIcon(androidx.core.graphics.drawable.IconCompat.createWithAdaptiveBitmap(canvasBmp))
                .setIntent(open)
                .build();
            boolean ok = androidx.core.content.pm.ShortcutManagerCompat.isRequestPinShortcutSupported(getContext())
                && androidx.core.content.pm.ShortcutManagerCompat.requestPinShortcut(getContext(), info, null);
            JSObject out = new JSObject();
            out.put("requested", ok);
            call.resolve(out);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    // ---------------------------------------------------------- updates
    /** Hands a downloaded APK to Android's installer. */
    @PluginMethod
    public void installApk(PluginCall call) {
        String path = call.getString("path");
        File file = path == null ? null : new File(path);
        if (file == null || !file.isFile()) { call.reject("file missing"); return; }
        if (Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
            Intent allow = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
            allow.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(allow);
            JSObject out = new JSObject();
            out.put("needsPermission", true);
            call.resolve(out);
            return;
        }
        Uri uri = androidx.core.content.FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
        Intent install = new Intent(Intent.ACTION_VIEW);
        install.setDataAndType(uri, "application/vnd.android.package-archive");
        install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(install);
        JSObject out = new JSObject();
        out.put("needsPermission", false);
        call.resolve(out);
    }

    // ------------------------------------------------------------ network
    /** The phone's address on the Wi-Fi (for casting). */
    @PluginMethod
    public void lanAddress(PluginCall call) {
        JSObject out = new JSObject();
        try {
            android.net.ConnectivityManager cm = (android.net.ConnectivityManager) getContext().getSystemService(android.content.Context.CONNECTIVITY_SERVICE);
            android.net.Network net = cm.getActiveNetwork();
            android.net.LinkProperties lp = net != null ? cm.getLinkProperties(net) : null;
            if (lp != null) for (android.net.LinkAddress a : lp.getLinkAddresses()) {
                if (a.getAddress() instanceof java.net.Inet4Address && !a.getAddress().isLoopbackAddress()) { out.put("ip", a.getAddress().getHostAddress()); break; }
            }
        } catch (Exception ignored) {}
        call.resolve(out);
    }

    /** Where the sound goes now: bluetooth, wired, speaker (for the audio test). */
    @PluginMethod
    public void audioOutput(PluginCall call) {
        JSObject out = new JSObject();
        String type = "speaker";
        try {
            android.media.AudioManager am = (android.media.AudioManager) getContext().getSystemService(android.content.Context.AUDIO_SERVICE);
            for (android.media.AudioDeviceInfo d : am.getDevices(android.media.AudioManager.GET_DEVICES_OUTPUTS)) {
                int k = d.getType();
                if (k == android.media.AudioDeviceInfo.TYPE_BLUETOOTH_A2DP || (Build.VERSION.SDK_INT >= 31 && (k == android.media.AudioDeviceInfo.TYPE_BLE_HEADSET || k == android.media.AudioDeviceInfo.TYPE_BLE_SPEAKER))) { type = "bluetooth"; break; }
                if (k == android.media.AudioDeviceInfo.TYPE_WIRED_HEADPHONES || k == android.media.AudioDeviceInfo.TYPE_WIRED_HEADSET || k == android.media.AudioDeviceInfo.TYPE_USB_HEADSET) type = "wired";
            }
        } catch (Exception ignored) {}
        out.put("type", type);
        call.resolve(out);
    }

    @PluginMethod
    public void requestNotifications(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "onNotifications");
            return;
        }
        call.resolve(accessState());
    }

    /** Restarts the app (its embedded Node.js can only start once per process). */
    @PluginMethod
    public void restartApp(PluginCall call) {
        call.resolve();
        Intent intent = getContext().getPackageManager().getLaunchIntentForPackage(getContext().getPackageName());
        if (intent == null) return;
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        getContext().startActivity(Intent.makeRestartActivityTask(intent.getComponent()));
        Runtime.getRuntime().exit(0);
    }
}
