// Firebase project adip-hku (same web config as the site's other pages). All demo data lives under shein/.
// Set to null to run on a local, in-browser database instead (one device only).
export const FIREBASE_CONFIG = {
    apiKey: "AIzaSyCu3igiyMcHc79z7xr6DSQ29OBPUf3pDJ0",
      authDomain: "adip-hku.firebaseapp.com",
      databaseURL: "https://adip-hku-default-rtdb.asia-southeast1.firebasedatabase.app",
      projectId: "adip-hku",
      storageBucket: "adip-hku.firebasestorage.app",
      messagingSenderId: "45076390506",
      appId: "1:45076390506:web:ff0f00a2f04bca0f432013"
};

// Cloudflare Worker that holds the API keys (Jev, HKU Gemini). `wrangler dev` serves on 8787.
export const WORKER_URL = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
  ? 'http://localhost:8787'
  : 'https://shein-cocreate-worker.guduruadip.workers.dev';

export const ONBOARDING_CARDS = 20;
export const BLEND = { user: 0.6, kol: 0.3, trend: 0.1 };
