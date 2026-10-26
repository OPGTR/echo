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
const file = path.join(root, 'node_modules', 'capacitor-nodejs', 'android', 'src', 'main', 'java', 'net', 'hampoelz', 'capacitor', 'nodejs', 'CapacitorNodeJS.java')
if (!fs.existsSync(file)) { console.log('[patch-nodejs] capacitor-nodejs not installed, nothing to do'); process.exit(0) }
let src = fs.readFileSync(file, 'utf8')
const MARK = '// ECHO-PATCH 1'
if (src.includes(MARK)) { console.log('[patch-nodejs] already patched'); process.exit(0) }

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
for (const [from, to] of edits) {
  const n = src.split(from).length - 1
  if (n !== 1) { console.error(`[patch-nodejs] expected once, found ${n}: ${from.split('\n')[0]}`); process.exit(1) }
  src = src.replace(from, to)
}
fs.writeFileSync(file, src)
console.log('[patch-nodejs] patched', path.relative(root, file))
