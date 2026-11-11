package com.tradesight.app;

import android.app.*;
import android.content.*;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.IBinder;
import android.view.*;
import android.widget.*;

public class TradeSightOverlayService extends Service {
  public static final String ACTION_START = "com.tradesight.app.OVERLAY_START";
  public static final String ACTION_UPDATE = "com.tradesight.app.OVERLAY_UPDATE";

  private WindowManager wm;
  private View panel;
  private TextView priceView, signalView, symbolView;
  private WindowManager.LayoutParams params;
  private String symbol = "XAUUSD", price = "Waiting for price", signal = "NO SETUP";

  private int dp(float value) {
    return (int) (value * getResources().getDisplayMetrics().density + 0.5f);
  }

  private GradientDrawable rounded(int color, int strokeColor, int radius) {
    GradientDrawable shape = new GradientDrawable();
    shape.setColor(color);
    shape.setCornerRadius(dp(radius));
    if (strokeColor != Color.TRANSPARENT) shape.setStroke(dp(1), strokeColor);
    return shape;
  }

  private TextView text(String value, int size, int color, boolean bold) {
    TextView view = new TextView(this);
    view.setText(value);
    view.setTextSize(size);
    view.setTextColor(color);
    if (bold) view.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
    return view;
  }

  @Override public void onCreate() {
    super.onCreate();
    wm = (WindowManager) getSystemService(WINDOW_SERVICE);
    NotificationChannel channel = new NotificationChannel(
      "tradesight-overlay", "TradeSight floating panel", NotificationManager.IMPORTANCE_LOW
    );
    getSystemService(NotificationManager.class).createNotificationChannel(channel);
    Notification n = new Notification.Builder(this, "tradesight-overlay")
      .setContentTitle("TradeSight floating panel is active")
      .setContentText("Your market panel is running")
      .setSmallIcon(android.R.drawable.ic_dialog_info)
      .build();
    startForeground(7312, n);
  }

  @Override public int onStartCommand(Intent intent, int flags, int startId) {
    if (intent != null) {
      if (intent.hasExtra("symbol")) symbol = intent.getStringExtra("symbol");
      if (intent.hasExtra("price")) price = intent.getStringExtra("price");
      if (intent.hasExtra("signal")) signal = intent.getStringExtra("signal");
      if (ACTION_START.equals(intent.getAction())) showPanel();
      else if (panel != null) render();
    }
    return START_STICKY;
  }

  private void showPanel() {
    if (panel != null) { render(); return; }

    LinearLayout card = new LinearLayout(this);
    card.setOrientation(LinearLayout.VERTICAL);
    card.setPadding(dp(16), dp(14), dp(16), dp(16));
    card.setBackground(rounded(Color.rgb(9, 20, 34), Color.rgb(48, 72, 94), 20));
    card.setElevation(dp(12));

    LinearLayout header = new LinearLayout(this);
    header.setGravity(Gravity.CENTER_VERTICAL);
    header.setOrientation(LinearLayout.HORIZONTAL);

    TextView brand = text("TRADESIGHT", 12, Color.rgb(89, 220, 183), true);
    brand.setLetterSpacing(0.12f);
    header.addView(brand, new LinearLayout.LayoutParams(0, dp(34), 1));

    TextView close = text("×", 25, Color.rgb(180, 196, 211), false);
    close.setGravity(Gravity.CENTER);
    close.setBackground(rounded(Color.rgb(24, 40, 57), Color.rgb(55, 78, 99), 18));
    close.setContentDescription("Close floating panel");
    close.setClickable(true);
    close.setFocusable(true);
    header.addView(close, new LinearLayout.LayoutParams(dp(44), dp(44)));
    close.setOnClickListener(v -> closePanel());

    View divider = new View(this);
    divider.setBackgroundColor(Color.rgb(39, 57, 76));
    LinearLayout.LayoutParams dividerParams = new LinearLayout.LayoutParams(
      LinearLayout.LayoutParams.MATCH_PARENT, dp(1)
    );
    dividerParams.topMargin = dp(12);
    dividerParams.bottomMargin = dp(13);

    LinearLayout marketRow = new LinearLayout(this);
    marketRow.setGravity(Gravity.CENTER_VERTICAL);
    symbolView = text(symbol, 13, Color.rgb(166, 184, 202), true);
    symbolView.setLetterSpacing(0.06f);
    marketRow.addView(symbolView, new LinearLayout.LayoutParams(0, dp(24), 1));

    TextView liveLabel = text("MARKET WATCH", 9, Color.rgb(116, 145, 169), true);
    liveLabel.setLetterSpacing(0.08f);
    marketRow.addView(liveLabel);

    priceView = text(price, 25, Color.WHITE, true);
    LinearLayout.LayoutParams priceParams = new LinearLayout.LayoutParams(
      LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
    );
    priceParams.topMargin = dp(5);
    priceParams.bottomMargin = dp(13);

    TextView signalCaption = text("CURRENT SIGNAL", 9, Color.rgb(116, 145, 169), true);
    signalCaption.setLetterSpacing(0.12f);

    signalView = text(signal, 12, Color.rgb(255, 204, 104), true);
    signalView.setGravity(Gravity.CENTER);
    signalView.setPadding(dp(12), dp(9), dp(12), dp(9));
    LinearLayout.LayoutParams signalParams = new LinearLayout.LayoutParams(
      LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
    );
    signalParams.topMargin = dp(7);

    card.addView(header);
    card.addView(divider, dividerParams);
    card.addView(marketRow);
    card.addView(priceView, priceParams);
    card.addView(signalCaption);
    card.addView(signalView, signalParams);
    panel = card;
    render();

    int type = Build.VERSION.SDK_INT >= 26
      ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
      : WindowManager.LayoutParams.TYPE_PHONE;
    params = new WindowManager.LayoutParams(
      dp(286), WindowManager.LayoutParams.WRAP_CONTENT, type,
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
      PixelFormat.TRANSLUCENT
    );
    params.gravity = Gravity.TOP | Gravity.END;
    params.x = dp(12);
    params.y = dp(150);

    // Keep drag handling on the brand area only so it cannot intercept the close button.
    brand.setOnTouchListener(new View.OnTouchListener() {
      int startX, startY;
      float touchX, touchY;
      public boolean onTouch(View view, android.view.MotionEvent event) {
        if (event.getAction() == MotionEvent.ACTION_DOWN) {
          startX = params.x; startY = params.y;
          touchX = event.getRawX(); touchY = event.getRawY();
          return true;
        }
        if (event.getAction() == MotionEvent.ACTION_MOVE) {
          params.x = startX + (int) (touchX - event.getRawX());
          params.y = startY + (int) (event.getRawY() - touchY);
          try { wm.updateViewLayout(panel, params); } catch (Exception ignored) {}
          return true;
        }
        return event.getAction() == MotionEvent.ACTION_UP
          || event.getAction() == MotionEvent.ACTION_CANCEL;
      }
    });

    try {
      wm.addView(panel, params);
    } catch (Exception e) {
      panel = null;
      stopSelf();
    }
  }

  private void closePanel() {
    if (panel != null) {
      try { wm.removeView(panel); } catch (Exception ignored) {}
      panel = null;
    }
    stopSelf();
  }

  private void render() {
    if (priceView == null || signalView == null) return;
    if (symbolView != null) symbolView.setText(symbol);
    priceView.setText(price == null || price.trim().isEmpty() ? "Price unavailable" : price);

    String normalized = signal == null ? "NO SETUP" : signal.trim().toUpperCase();
    boolean buy = normalized.contains("BUY");
    boolean sell = normalized.contains("SELL");
    int accent = buy ? Color.rgb(48, 211, 158)
      : sell ? Color.rgb(255, 105, 125) : Color.rgb(255, 204, 104);
    int background = buy ? Color.rgb(14, 61, 53)
      : sell ? Color.rgb(67, 30, 40) : Color.rgb(58, 47, 29);
    // Keep non-directional states neutral; never imply a trade from a missing signal.
    if (!buy && !sell) background = Color.rgb(58, 47, 29);
    signalView.setText(normalized.isEmpty() ? "NO SETUP" : normalized);
    signalView.setTextColor(accent);
    signalView.setBackground(rounded(background, Color.TRANSPARENT, 10));
  }

  @Override public void onDestroy() {
    if (panel != null) {
      try { wm.removeView(panel); } catch (Exception ignored) {}
      panel = null;
    }
    stopForeground(true);
    super.onDestroy();
  }

  @Override public IBinder onBind(Intent intent) { return null; }
}
