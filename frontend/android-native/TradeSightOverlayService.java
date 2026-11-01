package com.tradesight.app;

import android.app.*;
import android.content.*;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.os.Build;
import android.os.IBinder;
import android.view.*;
import android.widget.*;

public class TradeSightOverlayService extends Service {
  public static final String ACTION_START = "com.tradesight.app.OVERLAY_START";
  public static final String ACTION_UPDATE = "com.tradesight.app.OVERLAY_UPDATE";
  private WindowManager wm;
  private View panel;
  private TextView content;
  private WindowManager.LayoutParams params;
  private String symbol = "XAUUSD", price = "Waiting for price", signal = "NO SETUP";

  @Override public void onCreate() {
    super.onCreate();
    wm = (WindowManager)getSystemService(WINDOW_SERVICE);
    NotificationChannel channel = new NotificationChannel("tradesight-overlay", "TradeSight floating panel", NotificationManager.IMPORTANCE_LOW);
    getSystemService(NotificationManager.class).createNotificationChannel(channel);
    Notification n = new Notification.Builder(this, "tradesight-overlay")
      .setContentTitle("TradeSight floating panel is active")
      .setContentText("Tap TradeSight to return to the app")
      .setSmallIcon(android.R.drawable.ic_dialog_info).build();
    startForeground(7312, n);
  }
  @Override public int onStartCommand(Intent intent, int flags, int startId) {
    if (intent != null) {
      symbol = intent.getStringExtra("symbol") == null ? symbol : intent.getStringExtra("symbol");
      price = intent.getStringExtra("price") == null ? price : intent.getStringExtra("price");
      signal = intent.getStringExtra("signal") == null ? signal : intent.getStringExtra("signal");
      if (ACTION_START.equals(intent.getAction())) showPanel();
      else if (panel != null) render();
    }
    return START_STICKY;
  }
  private void showPanel() {
    if (panel != null) { render(); return; }
    LinearLayout box = new LinearLayout(this);
    box.setOrientation(LinearLayout.VERTICAL); box.setPadding(24,16,24,16);
    box.setBackgroundColor(Color.rgb(8,19,32));
    TextView head = new TextView(this); head.setText("TRADESIGHT  ·  ×"); head.setTextColor(Color.rgb(39,214,160)); head.setTextSize(13); head.setOnClickListener(v -> stopSelf());
    content = new TextView(this); content.setTextColor(Color.WHITE); content.setTextSize(14); content.setPadding(0,10,0,0);
    box.addView(head); box.addView(content); panel = box; render();
    int type = Build.VERSION.SDK_INT >= 26 ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY : WindowManager.LayoutParams.TYPE_PHONE;
    params = new WindowManager.LayoutParams(WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT, type,
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN, PixelFormat.TRANSLUCENT);
    params.gravity = Gravity.TOP | Gravity.END; params.x = 16; params.y = 180;
    box.setOnTouchListener(new View.OnTouchListener() {
      int sx, sy; float tx, ty;
      public boolean onTouch(View v, android.view.MotionEvent e) {
        if (e.getAction()==MotionEvent.ACTION_DOWN) { sx=params.x; sy=params.y; tx=e.getRawX(); ty=e.getRawY(); return true; }
        if (e.getAction()==MotionEvent.ACTION_MOVE) { params.x=sx+(int)(tx-e.getRawX()); params.y=sy+(int)(e.getRawY()-ty); wm.updateViewLayout(panel,params); return true; }
        return true;
      }
    });
    try { wm.addView(panel, params); } catch (Exception e) { stopSelf(); }
  }
  private void render() { if(content!=null) content.setText(symbol + "\\n" + price + "\\nSIGNAL: " + signal); }
  @Override public void onDestroy() { if(panel!=null) { try { wm.removeView(panel); } catch(Exception ignored){} panel=null; } stopForeground(true); super.onDestroy(); }
  @Override public IBinder onBind(Intent intent) { return null; }
}