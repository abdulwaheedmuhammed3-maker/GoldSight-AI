package com.tradesight.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import com.getcapacitor.*;
import com.getcapacitor.annotation.*;
import org.json.JSONObject;

@CapacitorPlugin(name = "TradeSightOverlay")
public class TradeSightOverlayPlugin extends Plugin {
  @PluginMethod public void checkPermission(PluginCall call) {
    JSObject out = new JSObject();
    out.put("granted", Build.VERSION.SDK_INT < 23 || Settings.canDrawOverlays(getContext()));
    call.resolve(out);
  }
  @PluginMethod public void requestPermission(PluginCall call) {
    if (Build.VERSION.SDK_INT >= 23 && !Settings.canDrawOverlays(getContext())) {
      Intent intent = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
        Uri.parse("package:" + getContext().getPackageName()));
      getActivity().startActivity(intent);
    }
    call.resolve();
  }
  @PluginMethod public void start(PluginCall call) {
    if (Build.VERSION.SDK_INT >= 23 && !Settings.canDrawOverlays(getContext())) {
      call.reject("Allow Display over other apps first."); return;
    }
    Intent intent = new Intent(getContext(), TradeSightOverlayService.class);
    intent.setAction(TradeSightOverlayService.ACTION_START);
    intent.putExtra("symbol", call.getString("symbol", "XAUUSD"));
    intent.putExtra("price", call.getString("price", "Waiting for price"));
    intent.putExtra("signal", call.getString("signal", "NO SETUP"));
    if (Build.VERSION.SDK_INT >= 26) getContext().startForegroundService(intent);
    else getContext().startService(intent);
    call.resolve();
  }
  @PluginMethod public void update(PluginCall call) {
    Intent intent = new Intent(getContext(), TradeSightOverlayService.class);
    intent.setAction(TradeSightOverlayService.ACTION_UPDATE);
    intent.putExtra("symbol", call.getString("symbol", "XAUUSD"));
    intent.putExtra("price", call.getString("price", "Waiting for price"));
    intent.putExtra("signal", call.getString("signal", "NO SETUP"));
    getContext().startService(intent);
    call.resolve();
  }
  @PluginMethod public void stop(PluginCall call) {
    Intent intent = new Intent(getContext(), TradeSightOverlayService.class);
    getContext().stopService(intent);
    call.resolve();
  }
}