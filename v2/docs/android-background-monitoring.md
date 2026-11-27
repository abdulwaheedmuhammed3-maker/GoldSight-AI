# Android background monitoring

## What the current native integration does

TradeSight includes a user-started Android foreground service (MarketMonitorService) exposed through the Capacitor MarketMonitor plugin.

When the user presses **Start background monitoring** in Signal Centre:

1. TradeSight asks for notification permission if needed.
2. Android starts a foreground dataSync service.
3. The service displays an ongoing notification and holds a time-limited partial wake lock.
4. The service raises the app process importance while the TradeSight WebView and its JavaScript market engine are expected to continue.
5. The user can stop the session from TradeSight.

The native service is a process-continuity aid. The quote WebSockets, signal scanner and TP2/SL evaluation still run in the TradeSight JavaScript engine. This integration does **not** move the complete market feed and outcome engine into a standalone native process. Reliable monitoring with the WebView destroyed, after force-stop, or under every manufacturer battery policy is therefore not yet guaranteed.

## Android limits

The service declares the dataSync foreground-service type and its matching permission. On Android 15 / API 35 and later, Android applies a six-hour total time limit per 24-hour period to dataSync foreground services. TradeSight also schedules its partial wake lock to release just before that limit. After Android ends a session, the user must reopen TradeSight and start a new session.

The service must be started from the visible app through an explicit user action. Do not start it silently at device boot. Android notification permission, foreground-service restrictions, Doze, network availability and manufacturer battery management can interrupt alerts.

## APK preparation

After adding the Android platform:

    npm run cap:add:android
    npm run build
    npm run cap:sync:android

The sync command runs scripts/prepare-android-native.cjs before Capacitor sync. It copies the native plugin/service into the generated Android app, adds manifest permissions and service declaration, and registers the plugin in MainActivity.

## Required real-device acceptance tests

1. Grant notification permission and start monitoring while TradeSight is visible.
2. Confirm the persistent monitoring notification appears.
3. Lock the phone and leave TradeSight in the background.
4. On a second device or test feed, move a test setup through TP2 and separately through SL.
5. Confirm the alert arrives with the right symbol, direction, milestone, observed price and source time.
6. Confirm no duplicate alert after reconnecting.
7. Confirm the service stops cleanly when the user presses Stop.
8. Test Android 15+ service timeout and verify the app reports that the session ended.

Until these tests pass on the target Android phone, describe background alert delivery as **in testing**, not guaranteed. A future fully independent background monitor will need a native quote client and native persisted setup/outcome store rather than relying on the WebView remaining active.
