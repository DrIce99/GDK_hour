package com.drice.gdkhour;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import com.nothing.ketchum.Common;
import com.nothing.ketchum.Glyph;
import com.nothing.ketchum.GlyphException;
import com.nothing.ketchum.GlyphFrame;
import com.nothing.ketchum.GlyphManager;

import java.util.Calendar;

public class GlyphClockService extends Service implements SensorEventListener {

    private static final String TAG = "GlyphClockService";
    public static final String ACTION_TEST_SEQUENCE = "com.drice.gdkhour.action.TEST";
    public static final String ACTION_TEST_BINARY = "com.drice.gdkhour.action.TEST_BINARY";

    public static final String PREFS = "glyph_clock_prefs";
    public static final String KEY_BLINK_PERIOD = "blinkPeriodMs";
    private static final int DEFAULT_BLINK_PERIOD = 500;

    private static final String CHANNEL_ID = "GLYPH_CLOCK_CHANNEL";
    private static final int NOTIFICATION_ID = 1;
    private static final int TICK_MS = 100;
    private static final float SHAKE_THRESHOLD = 12f;
    private static final float FACE_DOWN_Z = -5f;
    private static final long TOGGLE_DEBOUNCE_MS = 1000;

    // Mappatura canali Glyph per Nothing Phone (1)
    private static final int CH_A1 = 0;                          // AM (off) / PM (on)
    private static final int CH_B1 = 1;                          // 1º num (off) / 2º num (on) del quarto
    private static final int[] C_LEDS = {2, 3, 4, 5};            // Q1 (top-right), Q2 (bottom-right), Q3 (bottom-left), Q4 (top-left)
    private static final int CH_E1 = 6;                          // Pendolo secondi (pari=ON, dispari=OFF)
    private static final int[] D1_LEDS = {7, 8, 9, 10, 11, 12, 13, 14}; // 8 LED verticali D1 (dal basso in alto)

    private static volatile boolean running = false;
    private static volatile boolean displayOn = false;
    public static boolean isRunning() { return running; }
    public static boolean isDisplayOn() { return displayOn; }

    private GlyphManager mGM;
    private volatile boolean serviceConnected = false;

    private SensorManager sensorManager;
    private PowerManager.WakeLock wakeLock;
    private float currentAcceleration, lastAcceleration, smoothed;

    private volatile boolean sequenceRunning = false;
    private Thread sequenceThread;
    private String lastSignature = "";
    private long lastToggleMs = 0;

    private static final long BINARY_STEP_MS = 500;

    @Override
    public void onCreate() {
        super.onCreate();
        running = true;

        createNotificationChannel();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, buildNotification(false),
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIFICATION_ID, buildNotification(false));
        }

        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "GlyphClock:service");
        wakeLock.acquire();

        sensorManager = (SensorManager) getSystemService(SENSOR_SERVICE);
        sensorManager.registerListener(this,
                sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER),
                SensorManager.SENSOR_DELAY_NORMAL);
        currentAcceleration = lastAcceleration = SensorManager.GRAVITY_EARTH;
        smoothed = 0f;

        mGM = GlyphManager.getInstance(getApplicationContext());
        mGM.init(new GlyphManager.Callback() {
            @Override
            public void onServiceConnected(ComponentName name) {
                serviceConnected = true;
                if (Common.is20111()) mGM.register(Glyph.DEVICE_20111);
            }
            @Override
            public void onServiceDisconnected(ComponentName name) {
                serviceConnected = false;
            }
        });
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            String a = intent.getAction();
            if (ACTION_TEST_SEQUENCE.equals(a)) toggleDisplay();
            else if (ACTION_TEST_BINARY.equals(a)) startBinaryTest();
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        displayOn = false;
        if (sequenceThread != null) sequenceThread.interrupt();
        sensorManager.unregisterListener(this);
        try { mGM.turnOff(); } catch (Exception ignored) {}
        try { mGM.closeSession(); } catch (Exception ignored) {}
        mGM.unInit();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    // ---------------------------------------------------------------- sensore

    @Override
    public void onSensorChanged(SensorEvent event) {
        float x = event.values[0], y = event.values[1], z = event.values[2];
        lastAcceleration = currentAcceleration;
        currentAcceleration = (float) Math.sqrt(x * x + y * y + z * z);
        smoothed = smoothed * 0.9f + Math.abs(currentAcceleration - lastAcceleration);

        if (smoothed > SHAKE_THRESHOLD && z < FACE_DOWN_Z) {
            long now = SystemClock.elapsedRealtime();
            if (now - lastToggleMs > TOGGLE_DEBOUNCE_MS) {
                lastToggleMs = now;
                toggleDisplay();
            }
        }
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {}

    // ---------------------------------------------------------------- on/off

    private void toggleDisplay() {
        if (displayOn) {
            displayOn = false;
            Log.i(TAG, "Display orario OFF");
        } else {
            displayOn = true;
            Log.i(TAG, "Display orario ON");
            startSequenceIfNeeded();
        }
        NotificationManager mgr = getSystemService(NotificationManager.class);
        if (mgr != null) mgr.notify(NOTIFICATION_ID, buildNotification(displayOn));
    }

    private void startSequenceIfNeeded() {
        if (sequenceRunning) return;
        if (!serviceConnected) {
            Log.e(TAG, "Glyph non connesso, impossibile accendere il display");
            displayOn = false;
            return;
        }
        sequenceRunning = true;
        sequenceThread = new Thread(this::runSequence, "glyph-sequence");
        sequenceThread.start();
    }

    // ---------------------------------------------------------------- orologio in tempo reale

    private void runSequence() {
        try {
            mGM.openSession();
        } catch (GlyphException e) {
            Log.e(TAG, "openSession: " + e.getMessage());
            sequenceRunning = false;
            displayOn = false;
            return;
        }
        lastSignature = "";
        try {
            while (displayOn && running && !Thread.interrupted()) {
                Calendar cal = Calendar.getInstance();
                int hour24 = cal.get(Calendar.HOUR_OF_DAY);
                int minute = cal.get(Calendar.MINUTE);
                int second = cal.get(Calendar.SECOND);

                boolean isPm = hour24 >= 12;

                int h12 = cal.get(Calendar.HOUR);
                if (h12 == 0) h12 = 12;

                int secondParity = second % 2;

                String sig = isPm + "-" + h12 + "-" + minute + "-" + secondParity;

                if (!sig.equals(lastSignature)) {
                    lastSignature = sig;
                    try {
                        GlyphFrame.Builder b = mGM.getGlyphFrameBuilder();

                        // 1. A1: AM/PM
                        if (isPm) {
                            b.buildChannel(CH_A1);
                        }

                        // 2. C1: Ore su quadrante a quarti + B1: indicatore 1º/2º numero
                        // Mappatura orientamento fisico C1 corretta:
                        // C_LEDS[3] = In basso a sinistra (Q3)
                        // C_LEDS[0] = In alto a sinistra (Q4)
                        // C_LEDS[1] = In alto a destra (Q1)
                        // C_LEDS[2] = In basso a destra (Q2)

                        switch (h12) {
                            case 12: // IN ALTO: Q4 (Top-Left) + Q1 (Top-Right)
                                b.buildChannel(C_LEDS[3]);
                                b.buildChannel(C_LEDS[2]);
                                break;
                            case 1:
                            case 2:  // Quarto 1 (Top-Right)
                                b.buildChannel(C_LEDS[2]);
                                break;
                            case 3:  // A DESTRA: Q1 (Top-Right) + Q2 (Bottom-Right)
                                b.buildChannel(C_LEDS[2]);
                                b.buildChannel(C_LEDS[1]);
                                break;
                            case 4:
                            case 5:  // Quarto 2 (Bottom-Right)
                                b.buildChannel(C_LEDS[1]);
                                break;
                            case 6:  // IN BASSO: Q2 (Bottom-Right) + Q3 (Bottom-Left)
                                b.buildChannel(C_LEDS[1]);
                                b.buildChannel(C_LEDS[0]);
                                break;
                            case 7:
                            case 8:  // Quarto 3 (Bottom-Left)
                                b.buildChannel(C_LEDS[0]);
                                break;
                            case 9:  // A SINISTRA: Q3 (Bottom-Left) + Q4 (Top-Left)
                                b.buildChannel(C_LEDS[3]);
                                b.buildChannel(C_LEDS[0]);
                                break;
                            case 10:
                            case 11: // Quarto 4 (Top-Left)
                                b.buildChannel(C_LEDS[3]);
                                break;
                        }

                        // B1: acceso solo per i secondi numeri del quarto (2, 5, 8, 11)
                        if (h12 == 2 || h12 == 5 || h12 == 8 || h12 == 11) {
                            b.buildChannel(CH_B1);
                        }

                        // 3. D1: Minuti in binario a 6 bit (2^0 dal basso)
                        // Bit 0 (2^0 = 1): LED 1
                        if ((minute & (1 << 0)) != 0) b.buildChannel(D1_LEDS[0]);
                        // Bit 1 (2^1 = 2): LED 2
                        if ((minute & (1 << 1)) != 0) b.buildChannel(D1_LEDS[1]);
                        // Bit 2 (2^2 = 4): LED 3 e LED 4 uniti
                        if ((minute & (1 << 2)) != 0) {
                            b.buildChannel(D1_LEDS[2]);
                            b.buildChannel(D1_LEDS[3]);
                        }
                        // Bit 3 (2^3 = 8): LED 5 e LED 6 uniti
                        if ((minute & (1 << 3)) != 0) {
                            b.buildChannel(D1_LEDS[4]);
                            b.buildChannel(D1_LEDS[5]);
                        }
                        // Bit 4 (2^4 = 16): LED 7
                        if ((minute & (1 << 4)) != 0) b.buildChannel(D1_LEDS[6]);
                        // Bit 5 (2^5 = 32): LED 8
                        if ((minute & (1 << 5)) != 0) b.buildChannel(D1_LEDS[7]);

                        // 4. E1: Pendolo dei secondi (pari=ON, dispari=OFF)
                        if (secondParity == 0) {
                            b.buildChannel(CH_E1);
                        }

                        mGM.toggle(b.build());
                    } catch (Exception e) {
                        Log.e(TAG, "renderFrame: " + e.getMessage());
                    }
                }
                sleep(TICK_MS);
            }
        } finally {
            try { mGM.turnOff(); } catch (Exception ignored) {}
            try { mGM.closeSession(); } catch (Exception ignored) {}
            lastSignature = "";
            sequenceRunning = false;
            if (displayOn && running) startSequenceIfNeeded();
        }
    }

    // ---------------------------------------------------------------- test binario

    private void startBinaryTest() {
        if (!serviceConnected) return;
        displayOn = false;
        long wait = SystemClock.elapsedRealtime();
        while (sequenceRunning && SystemClock.elapsedRealtime() - wait < 600) sleep(20);
        if (sequenceRunning) { Log.w(TAG, "Test binario annullato: sequenza occupata"); return; }
        sequenceRunning = true;
        new Thread(() -> {
            try {
                runBinaryTest();
            } finally {
                sequenceRunning = false;
            }
        }, "glyph-binary-test").start();
    }

    private void runBinaryTest() {
        try {
            mGM.openSession();
        } catch (GlyphException e) {
            Log.e(TAG, "openSession: " + e.getMessage());
            return;
        }
        try {
            for (int value = 0; value <= 255; value++) {
                if (!running || Thread.interrupted()) break;
                GlyphFrame.Builder b = mGM.getGlyphFrameBuilder();
                for (int bit = 0; bit < D1_LEDS.length; bit++) {
                    if ((value & (1 << bit)) != 0) b.buildChannel(D1_LEDS[bit]);
                }
                mGM.toggle(b.build());
                sleep(BINARY_STEP_MS);
            }
        } finally {
            try { mGM.turnOff(); } catch (Exception ignored) {}
            try { mGM.closeSession(); } catch (Exception ignored) {}
        }
    }

    // ---------------------------------------------------------------- utility

    private Notification buildNotification(boolean on) {
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("Glyph Clock attivo")
                .setContentText(on
                        ? "Display orario ON: scuoti il telefono per spegnere."
                        : "In attesa di una scossa a schermo in giù...")
                .setSmallIcon(R.drawable.ic_launcher_foreground)
                .setOngoing(true)
                .build();
    }

    private static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }

    private void createNotificationChannel() {
        NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID, "Glyph Background Service", NotificationManager.IMPORTANCE_LOW);
        NotificationManager mgr = getSystemService(NotificationManager.class);
        if (mgr != null) mgr.createNotificationChannel(ch);
    }
}