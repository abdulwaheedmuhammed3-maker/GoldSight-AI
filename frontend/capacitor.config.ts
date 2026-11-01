import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.tradesight.app',
  appName: 'TradeSight',
  webDir: 'dist',
  plugins: {
    SplashScreen: {
      // Let Android's launch window transition straight into our own full-screen
      // React splash. The native launch graphic is transparent by design.
      launchShowDuration: 10000,
      launchAutoHide: false,
      launchFadeOutDuration: 0,
      backgroundColor: '#020b15',
      androidSplashResourceName: 'splash',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
      splashFullScreen: true,
    },
  },
};

export default config;
