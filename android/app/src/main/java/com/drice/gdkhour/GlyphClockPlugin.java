package com.drice.gdkhour;

import android.content.Intent;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "GlyphClock")
public class GlyphClockPlugin extends Plugin {

    @PluginMethod
    public void startBackgroundClock(PluginCall call) {
        Integer period = call.getInt("blinkPeriodMs");
        if (period != null) savePeriod(period);
        getContext().startForegroundService(new Intent(getContext(), GlyphClockService.class));
        call.resolve();
    }

    @PluginMethod
    public void stopBackgroundClock(PluginCall call) {
        getContext().stopService(new Intent(getContext(), GlyphClockService.class));
        call.resolve();
    }

    @PluginMethod
    public void setBlinkPeriod(PluginCall call) {
        Integer period = call.getInt("blinkPeriodMs");
        if (period == null || period < 100) { call.reject("blinkPeriodMs non valido (min 100)"); return; }
        savePeriod(period);
        call.resolve();
    }

    @PluginMethod
    public void testSequence(PluginCall call) {
        if (!GlyphClockService.isRunning()) { call.reject("Servizio non attivo"); return; }
        Intent i = new Intent(getContext(), GlyphClockService.class);
        i.setAction(GlyphClockService.ACTION_TEST_SEQUENCE);
        getContext().startService(i);
        call.resolve();
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("running", GlyphClockService.isRunning());
        ret.put("displayOn", GlyphClockService.isDisplayOn());
        ret.put("blinkPeriodMs", getContext()
                .getSharedPreferences(GlyphClockService.PREFS, 0)
                .getInt(GlyphClockService.KEY_BLINK_PERIOD, 500));
        call.resolve(ret);
    }

    private void savePeriod(int p) {
        getContext().getSharedPreferences(GlyphClockService.PREFS, 0)
                .edit().putInt(GlyphClockService.KEY_BLINK_PERIOD, p).apply();
    }

    @PluginMethod
    public void testBinary(PluginCall call) {
        if (!GlyphClockService.isRunning()) { call.reject("Servizio non attivo"); return; }
        Intent i = new Intent(getContext(), GlyphClockService.class);
        i.setAction(GlyphClockService.ACTION_TEST_BINARY);
        getContext().startService(i);
        call.resolve();
    }
}