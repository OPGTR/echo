// Runs after `npm install` / `npm ci` (postinstall).
//
// capacitor-nodejs starts Node.js when the app's window opens. In the car,
// Android Auto can start Écho's player without the window (phone in the
// pocket, Écho not opened): the player then starts Node.js itself, so the
// car can list your playlists and play them. This makes the engine one per
// process (whoever starts it first, the other one finds it running) and lets
// the player hear Node's messages ("echo-ready": where the server is).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = path.join(root, 'node_modules', 'capacitor-nodejs', 'android', 'src', 'main', 'java', 'net', 'hampoelz', 'capacitor', 'nodejs')
const file = path.join(dir, 'CapacitorNodeJS.java')
const processFile = path.join(dir, 'NodeProcess.java')
if (!fs.existsSync(file)) { console.log('[patch-nodejs] capacitor-nodejs not installed, nothing to do'); process.exit(0) }
let src = fs.readFileSync(file, 'utf8')
let processSrc = fs.readFileSync(processFile, 'utf8')
const MARK = '// ECHO-PATCH 1'
const MARK2 = '// ECHO-PATCH 2'

const edits = [
  ['    private class EngineStatus {', '    private static class EngineStatus {'],
  ['    private final EngineStatus engineStatus = new EngineStatus();', '    private static final EngineStatus engineStatus = new EngineStatus();'],
  ['    private final NodeProcess nodeProcess = new NodeProcess(new ReceiveCallback());',
    `    ${MARK}: one Node.js per process, started by the app or by Écho's player.
    private static final NodeProcess nodeProcess = new NodeProcess(new ReceiveCallback());
    private static volatile CapacitorNodeJS current;
    public interface EchoHook { void receive(String eventName, String eventMessage); }
    public static volatile EchoHook echoHook;

    /** Écho: starts Node.js without the app's window (Android Auto). Does nothing when it runs already. */
    public static boolean echoStart(Context context, String projectDir) {
        synchronized (CapacitorNodeJS.class) { if (engineStatus.isStarted()) return false; }
        new CapacitorNodeJS(context.getApplicationContext(), null).startEngine(null, projectDir, null, new String[] {}, new HashMap<>());
        return true;
    }
    public static boolean echoStarted() { return engineStatus.isStarted(); }
    public static boolean echoReady() { return engineStatus.isReady(); }
    /** Écho: a message to Node.js (like the app's NodeJS.send). */
    public static void echoSend(String eventName, String argsJson) {
        if (!engineStatus.isReady()) return;
        final JSObject data = new JSObject();
        data.put("eventName", eventName);
        data.put("eventMessage", argsJson);
        nodeProcess.send(CapacitorNodeJSPlugin.CHANNEL_NAME_EVENT, data.toString());
    }`],
  ['        this.eventNotifier = eventNotifier;\n', '        this.eventNotifier = eventNotifier;\n        // The app\'s instance (it has the window to tell) takes over from the player\'s.\n        if (eventNotifier != null || current == null) current = this;\n'],
  [`        if (engineStatus.isStarted()) {
            callWrapper.reject("The Node.js engine has already been started.");
            return;
        }
        engineStatus.setStarted();`,
    `        synchronized (CapacitorNodeJS.class) {
            // Started already (by Écho's player): the app uses that one.
            if (engineStatus.isStarted()) { callWrapper.resolve(); return; }
            engineStatus.setStarted();
        }`],
  ['    class ReceiveCallback implements NodeProcess.ReceiveCallback {', '    static class ReceiveCallback implements NodeProcess.ReceiveCallback {'],
  ['            receiveMessage(channelName, message);', '            final CapacitorNodeJS c = current;\n            if (c != null) c.receiveMessage(channelName, message);'],
  ['                eventNotifier.channelReceive(eventName, args);',
    '                final EchoHook hook = echoHook;\n                if (hook != null) hook.receive(eventName, eventMessage);\n                if (eventNotifier != null) eventNotifier.channelReceive(eventName, args);'],
]
// Pass 2: what the engine is doing, for Écho's "couldn't start" screen
// (which step it reached, what failed, the server's last log lines), and the
// server's "echo-ready" message kept for the app to ask for.
const edits2 = [
  ['    public static volatile EchoHook echoHook;\n', `    public static volatile EchoHook echoHook;

    ${MARK2}: what the engine is doing, for the "couldn't start" screen.
    public static volatile String echoPhase = "idle";
    public static volatile String echoError;
    public static volatile int echoExit = Integer.MIN_VALUE;
    public static volatile String echoAnnounce;
    public static volatile long echoBeganAt, echoReadyAt;
    public static volatile int echoMessages;
    private static final java.util.ArrayDeque<String> echoLines = new java.util.ArrayDeque<>();

    static void echoNote(String eventName, String eventMessage) {
        if ("echo-ready".equals(eventName)) {
            try { echoAnnounce = new org.json.JSONArray(eventMessage).getString(0); } catch (Exception ignored) {}
        } else if ("echo-log".equals(eventName)) {
            synchronized (echoLines) {
                final String line = eventMessage == null ? "" : eventMessage;
                echoLines.addLast(line.length() > 300 ? line.substring(0, 300) : line);
                while (echoLines.size() > 40) echoLines.removeFirst();
            }
        }
    }

    /** The engine's state as JSON. */
    public static String echoReport() {
        final org.json.JSONObject o = new org.json.JSONObject();
        try {
            o.put("started", engineStatus.isStarted());
            o.put("ready", engineStatus.isReady());
            o.put("phase", echoPhase);
            if (echoError != null) o.put("error", echoError);
            if (echoExit != Integer.MIN_VALUE) o.put("exit", echoExit);
            o.put("announced", echoAnnounce != null);
            o.put("messages", echoMessages);
            final long now = System.currentTimeMillis();
            if (echoBeganAt > 0) o.put("sinceStartMs", now - echoBeganAt);
            if (echoReadyAt > 0) o.put("readyAfterMs", echoReadyAt - echoBeganAt);
            final org.json.JSONArray lines = new org.json.JSONArray();
            synchronized (echoLines) { for (String l : echoLines) lines.put(l); }
            o.put("lines", lines);
        } catch (org.json.JSONException ignored) {}
        return o.toString();
    }

    /** The server's "echo-ready" message ({port, token, mediaToken}) when it has been heard; asks Node.js again when not. */
    public static String echoInfo() {
        if (echoAnnounce == null && engineStatus.isReady()) echoSend("echo-hello", "[]");
        return echoAnnounce;
    }
`],
  ['            public void reject(String message) {', '            public void reject(String message) {\n                echoError = message;'],
  ['            public void reject(String message, Exception e) {', '            public void reject(String message, Exception e) {\n                echoError = message + " (" + e + ")";'],
  ['        Thread engine = new Thread(() -> {\n', '        Thread engine = new Thread(() -> {\n            echoBeganAt = System.currentTimeMillis();\n            echoPhase = "copy";\n'],
  ['            nodeProcess.start(projectMainPath, args, nodeEnv, cachePath);\n            callWrapper.resolve();',
    '            echoPhase = "node";\n            nodeProcess.start(projectMainPath, args, nodeEnv, cachePath);\n            echoPhase = "node-exited";\n            callWrapper.resolve();'],
  ['        engine.start();\n', '        engine.setUncaughtExceptionHandler((t, e) -> {\n            echoError = "engine thread: " + e;\n            echoPhase = "failed";\n            Logger.error(CapacitorNodeJSPlugin.LOGGER_TAG, "The Node.js engine thread failed.", e);\n        });\n        engine.start();\n'],
  ['            final JSObject payload = new JSObject(channelMessage);', '            echoMessages++;\n            final JSObject payload = new JSObject(channelMessage);'],
  ['                engineStatus.setReady();', '                engineStatus.setReady();\n                echoReadyAt = System.currentTimeMillis();\n                echoPhase = "ready";'],
  ['                final EchoHook hook = echoHook;', '                echoNote(eventName, eventMessage);\n                final EchoHook hook = echoHook;'],
]
const processEdits2 = [
  ['        nativeStart(arguments, environmentVariables, true);', `        ${MARK2}: keep how Node.js ended.\n        CapacitorNodeJS.echoExit = nativeStart(arguments, environmentVariables, true);`],
]

function apply(text, list, name) {
  for (const [from, to] of list) {
    const n = text.split(from).length - 1
    if (n !== 1) { console.error(`[patch-nodejs] ${name}: expected once, found ${n}: ${from.split('\n')[0]}`); process.exit(1) }
    text = text.replace(from, () => to)
  }
  return text
}
if (!src.includes(MARK)) src = apply(src, edits, 'pass 1')
if (!src.includes(MARK2)) src = apply(src, edits2, 'pass 2')
if (!processSrc.includes(MARK2)) processSrc = apply(processSrc, processEdits2, 'NodeProcess')
fs.writeFileSync(file, src)
fs.writeFileSync(processFile, processSrc)
console.log('[patch-nodejs] patched', path.relative(root, file))
