// Platform adapter: the game runs on our own site, on itch.io and (with their
// SDK) on Poki. Everything platform-specific goes through this object so the
// rest of the code never checks where it is running.
//
//   platform.id              'web' | 'itch' | 'poki'
//   platform.init()          resolves when the platform is ready (Poki SDK loaded)
//   platform.loaded()        tell the platform the game is ready to play
//   platform.gameplayStart() a match starts / resumes
//   platform.gameplayStop()  a match ends or the player leaves it
//   platform.commercialBreak(onPause, onResume)  resolves after the ad (or immediately)
//   platform.allowExternalLinks  false on portals that forbid links out of the game
//   platform.allowPayments       false where the store's own billing is mandatory (Google Play) or payments are banned (Poki)
//   platform.useServiceWorker    false when hosted inside a portal iframe
//   platform.allowAccounts       false inside portal iframes: Google refuses to sign in
//                                in a frame, the portal's CDN origin is not among
//                                Supabase's redirect URLs, and it changes per upload

function detect() {
  if (typeof location === 'undefined') return 'web';
  if (typeof window !== 'undefined' && window.__PLATFORM) return window.__PLATFORM; // stamped into portal builds
  const forced = new URLSearchParams(location.search).get('platform');
  if (forced === 'poki' || forced === 'itch' || forced === 'web' || forced === 'android') return forced;
  // Google Play (Trusted Web Activity): the first navigation comes from android-app://; remember it for the session
  try {
    if (document.referrer.startsWith('android-app://') || new URLSearchParams(location.search).get('twa') === '1') sessionStorage.setItem('snackmageddon.twa', '1');
    if (sessionStorage.getItem('snackmageddon.twa') === '1') return 'android';
  } catch { /* storage blocked */ }
  const h = location.hostname;
  if (h.endsWith('.itch.zone') || h.endsWith('.itch.io')) return 'itch';
  if (h.endsWith('.poki.com') || h.endsWith('.poki-gdn.com') || h.endsWith('poki.dev')) return 'poki';
  return 'web';
}

const noop = {
  id: 'web',
  allowExternalLinks: true,
  allowPayments: true,
  useServiceWorker: true,
  allowAccounts: true,
  async init() {},
  loaded() {},
  gameplayStart() {},
  gameplayStop() {},
  async commercialBreak() {},
  async rewardedBreak() { return false; },
};

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('could not load ' + src));
    document.head.appendChild(s);
  });
}

const poki = {
  ...noop,
  id: 'poki',
  allowExternalLinks: false,
  allowPayments: false,
  useServiceWorker: false,
  allowAccounts: false,
  sdk: null,
  ready: false, // true once PokiSDK.init() has resolved; nothing is called on the SDK before that
  async init() {
    try {
      await loadScript('https://game-cdn.poki.com/scripts/v2/poki-sdk.js');
      const sdk = window.PokiSDK;
      if (new URLSearchParams(location.search).get('pokidebug')) sdk.setDebug(true);
      await sdk.init();
      this.sdk = sdk;
      this.ready = true;
    } catch {
      this.sdk = null; // ad blocker or offline: the game must still work
    }
  },
  loaded() { if (this.ready) this.sdk.gameLoadingFinished(); },
  gameplayStart() { if (this.ready) this.sdk.gameplayStart(); },
  gameplayStop() { if (this.ready) this.sdk.gameplayStop(); },
  async commercialBreak(onPause, onResume) {
    if (!this.ready) return;
    try {
      await this.sdk.commercialBreak(onPause);
    } finally {
      onResume?.();
    }
  },
  async rewardedBreak(onPause, onResume) {
    if (!this.ready) return false;
    try {
      return await this.sdk.rewardedBreak(onPause);
    } catch {
      return false;
    } finally {
      onResume?.();
    }
  },
};

const itch = {
  ...noop,
  id: 'itch',
  allowExternalLinks: true,
  allowPayments: false, // itch has its own store; keep the web build the only place that sells
  useServiceWorker: false, // itch serves the game from a sandboxed CDN origin per upload
  allowAccounts: false, // anonymous Snigelpost works, linking does not (see above); the menu points to snails.se
};

// Google Play wraps the site in a Trusted Web Activity. Everything works as on the
// web, but Play's payments policy requires Google Play Billing for digital goods,
// so the Stripe purchases are hidden here.
const android = {
  ...noop,
  id: 'android',
  allowPayments: false,
};

export const platform = { web: noop, itch, poki, android }[detect()];
