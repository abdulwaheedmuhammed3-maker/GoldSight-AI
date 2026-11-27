package com.tradesight.mobile;

import android.content.Intent;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "MarketMonitor")
public final class MarketMonitorPlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        String title = call.getString("title", "TradeSight monitoring active");
        String body = call.getString("body", "Live market monitoring session is active.");

        Intent intent = new Intent(getContext(), MarketMonitorService.class);
        intent.setAction(MarketMonitorService.ACTION_START);
        intent.putExtra(MarketMonitorService.EXTRA_TITLE, title);
        intent.putExtra(MarketMonitorService.EXTRA_BODY, body);

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                getContext().startForegroundService(intent);
            } else {
                getContext().startService(intent);
            }
            call.resolve(status());
        } catch (RuntimeException error) {
            call.reject("Could not start the Android monitoring service: " + error.getMessage(), error);
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Intent intent = new Intent(getContext(), MarketMonitorService.class);
        intent.setAction(MarketMonitorService.ACTION_STOP);
        try {
            getContext().startService(intent);
        } catch (RuntimeException ignored) {
            getContext().stopService(new Intent(getContext(), MarketMonitorService.class));
        }
        call.resolve(status());
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        call.resolve(status());
    }

    private JSObject status() {
        JSObject result = new JSObject();
        result.put("running", MarketMonitorService.isRunning(getContext()));
        long startedAt = MarketMonitorService.getStartedAt(getContext());
        result.put("startedAtMs", startedAt > 0 ? startedAt : null);
        String stopReason = MarketMonitorService.getStopReason(getContext());
        result.put("stopReason", stopReason);
        return result;
    }
}
