package tw.lanepilot.lanedev;

import android.content.Intent;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.location.LocationManager;
import android.net.Uri;
import android.os.SystemClock;
import android.provider.Settings;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.view.Surface;
import android.view.WindowManager;
import android.webkit.WebView;
import androidx.core.location.LocationManagerCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import org.json.JSONObject;
import java.util.Collections;
import java.util.Locale;
import java.util.ArrayList;
import java.util.List;

/** Only the bundled top-level HTTPS page can invoke device services. */
final class NativeServices implements SensorEventListener {
    private final MainActivity activity;
    private final WebView view;
    private final SensorManager sensors;
    private final Sensor rotation;
    private TextToSpeech tts;
    private boolean ready, resumed, destroyed, navigating, initializing;
    private boolean bridgeAvailable;
    private String ttsStatus = "正在初始化中文語音…";
    private long lastHeadingAt;
    private int queuedSpeech;
    private String pendingSpeech;
    private long pendingSpeechAt;
    private final List<String> locationRequests = new ArrayList<>();

    NativeServices(MainActivity activity, WebView view) {
        this.activity = activity;
        this.view = view;
        sensors = (SensorManager) activity.getSystemService(MainActivity.SENSOR_SERVICE);
        rotation = sensors.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR);
        bridgeAvailable = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER);
        if (bridgeAvailable) {
            WebViewCompat.addWebMessageListener(view, "LaneNative",
                Collections.singleton(MainActivity.APP_ORIGIN),
                (webView, message, origin, mainFrame, reply) -> {
                    if (!mainFrame || !MainActivity.APP_ORIGIN.equals(origin.toString())) return;
                    try { handle(new JSONObject(message.getData())); }
                    catch (Exception ignored) { /* Ignore malformed messages. */ }
                });
        }
        initializeSpeech();
    }

    private void initializeSpeech() {
        if (destroyed || initializing) return;
        initializing = true;
        ready = false;
        if (tts != null) tts.shutdown();
        tts = new TextToSpeech(activity, status -> activity.runOnUiThread(() -> {
            if (destroyed) return;
            initializing = false;
            if (status != TextToSpeech.SUCCESS) {
                ttsStatus = "語音服務無法啟動，請安裝或啟用文字轉語音引擎";
            } else {
                Voice voice = null;
                int bestScore = -1;
                if (tts.getVoices() != null) {
                    for (Voice candidate : tts.getVoices()) {
                        if (!"zh".equals(candidate.getLocale().getLanguage())
                                || (candidate.getFeatures() != null && candidate.getFeatures().contains("notInstalled"))) continue;
                        int score = (candidate.isNetworkConnectionRequired() ? 0 : 2)
                                + ("TW".equals(candidate.getLocale().getCountry()) ? 1 : 0);
                        if (score > bestScore) { voice = candidate; bestScore = score; }
                    }
                }
                if (voice != null && tts.setVoice(voice) == TextToSpeech.SUCCESS) {
                    ready = true;
                    ttsStatus = (voice.isNetworkConnectionRequired() ? "中文語音已就緒，需網路（" : "離線中文語音已就緒（")
                            + voice.getLocale().toLanguageTag() + "）";
                } else {
                    ttsStatus = "缺少可用中文語音，請在語音設定下載中文語音資料";
                }
                tts.setSpeechRate(0.95f);
                tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override public void onStart(String id) {}
                    @Override public void onDone(String id) { finishSpeech(false); }
                    @Override public void onError(String id) { finishSpeech(true); }
                });
            }
            status();
            if (ready && pendingSpeech != null && SystemClock.elapsedRealtime() - pendingSpeechAt < 15000) {
                String text = pendingSpeech;
                pendingSpeech = null;
                speak(text);
            }
        }));
    }

    private void finishSpeech(boolean failed) {
        activity.runOnUiThread(() -> {
            queuedSpeech = Math.max(0, queuedSpeech - 1);
            if (failed) { ttsStatus = "語音播放失敗，請檢查手機語音設定"; status(); }
        });
    }

    private void speak(String text) {
        if (text.isBlank() || text.length() > 1000 || !resumed) return;
        if (!ready) { pendingSpeech = text; pendingSpeechAt = SystemClock.elapsedRealtime(); status(); return; }
        if (queuedSpeech >= 3) return; // Avoid reading stale distances after a long queue.
        int result = tts.speak(text, TextToSpeech.QUEUE_ADD, null, "nav-" + System.nanoTime());
        if (result == TextToSpeech.SUCCESS) queuedSpeech++;
        else { ttsStatus = "語音播放失敗，請檢查手機語音設定"; status(); }
    }

    private void handle(JSONObject command) {
        switch (command.optString("type")) {
            case "status": status(); break;
            case "speak": speak(command.optString("text")); break;
            case "stopSpeech": stopSpeech(); break;
            case "requestLocation":
                locationRequests.add(command.optString("id"));
                if (activity.hasLocationPermission()) completeLocationRequests();
                else activity.requestLocationPermission();
                break;
            case "navigation":
                navigating = command.optBoolean("active");
                updateKeepScreenOn();
                break;
            case "ttsSettings": open(new Intent("com.android.settings.TTS_SETTINGS")); break;
            case "locationSettings": open(new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS)); break;
            case "appSettings": open(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.parse("package:" + activity.getPackageName()))); break;
            default: break;
        }
    }

    private void open(Intent intent) {
        try { activity.startActivity(intent); }
        catch (android.content.ActivityNotFoundException ignored) {
            if ("com.android.settings.TTS_SETTINGS".equals(intent.getAction())) {
                try { activity.startActivity(new Intent(TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA)); }
                catch (android.content.ActivityNotFoundException missing) {
                    ttsStatus = "沒有可用的語音設定，請先安裝文字轉語音引擎";
                    status();
                }
            }
        }
    }

    boolean locationEnabled() {
        return LocationManagerCompat.isLocationEnabled(
                (LocationManager) activity.getSystemService(MainActivity.LOCATION_SERVICE));
    }

    void completeLocationRequests() {
        String error = !activity.hasLocationPermission()
            ? "未授權定位，請在設定中的 App 定位權限允許精確位置"
            : !locationEnabled() ? "手機定位已關閉，請在設定中開啟手機定位後重試" : "";
        for (String id : locationRequests) emit("locationResult", "id", id, "error", error);
        locationRequests.clear();
        status();
    }

    void status() {
        emit("status", "tts", bridgeAvailable ? ttsStatus : "請更新 Android System WebView 以啟用語音服務",
            "location", !activity.hasLocationPermission() ? "定位尚未授權"
                : !locationEnabled() ? "手機定位已關閉"
                : activity.hasFineLocationPermission() ? "精確定位權限已開啟" : "僅允許概略位置，請開啟精確定位",
            "compass", rotation == null ? "裝置沒有方向感測器，使用 GPS 行進方向"
                : "方向感測器已啟用；若方向不準，請遠離磁性物品並校正手機");
    }

    private void emit(String type, Object... pairs) {
        if (destroyed) return;
        try {
            JSONObject data = new JSONObject().put("type", type);
            for (int i = 0; i < pairs.length; i += 2) data.put((String) pairs[i], pairs[i + 1]);
            if (view.getUrl() != null && view.getUrl().startsWith(MainActivity.APP_ORIGIN + "/"))
                view.evaluateJavascript("window.dispatchEvent(new CustomEvent('lane-native',{detail:" + data + "}))", null);
        } catch (org.json.JSONException ignored) {}
    }

    private void updateKeepScreenOn() {
        if (resumed && navigating) activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        else activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    void resume() {
        resumed = true;
        if (rotation != null) sensors.registerListener(this, rotation, SensorManager.SENSOR_DELAY_UI);
        updateKeepScreenOn();
        if (!ready) initializeSpeech();
        status();
    }

    void pause() {
        resumed = false;
        sensors.unregisterListener(this);
        emit("heading", "value", JSONObject.NULL);
        stopSpeech();
        updateKeepScreenOn();
    }

    void stopSpeech() {
        pendingSpeech = null;
        queuedSpeech = 0;
        if (tts != null) tts.stop();
    }

    void destroy() {
        destroyed = true;
        sensors.unregisterListener(this);
        if (tts != null) { tts.stop(); tts.shutdown(); }
        locationRequests.clear();
    }

    @Override public void onSensorChanged(SensorEvent event) {
        if (!resumed || event.accuracy == SensorManager.SENSOR_STATUS_UNRELIABLE) return;
        long now = SystemClock.elapsedRealtime();
        if (now - lastHeadingAt < 200) return;
        lastHeadingAt = now;
        float[] matrix = new float[9], adjusted = new float[9], orientation = new float[3];
        SensorManager.getRotationMatrixFromVector(matrix, event.values);
        int x = SensorManager.AXIS_X, y = SensorManager.AXIS_Y;
        switch (activity.getWindowManager().getDefaultDisplay().getRotation()) {
            case Surface.ROTATION_90: x = SensorManager.AXIS_Y; y = SensorManager.AXIS_MINUS_X; break;
            case Surface.ROTATION_180: x = SensorManager.AXIS_MINUS_X; y = SensorManager.AXIS_MINUS_Y; break;
            case Surface.ROTATION_270: x = SensorManager.AXIS_MINUS_Y; y = SensorManager.AXIS_X; break;
            default: break;
        }
        SensorManager.remapCoordinateSystem(matrix, x, y, adjusted);
        SensorManager.getOrientation(adjusted, orientation);
        emit("heading", "value", (Math.toDegrees(orientation[0]) + 360) % 360);
    }

    @Override public void onAccuracyChanged(Sensor sensor, int accuracy) {
        if (accuracy == SensorManager.SENSOR_STATUS_UNRELIABLE) emit("heading", "value", JSONObject.NULL);
    }
}
