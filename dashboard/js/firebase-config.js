/* Firebase project settings.

   Paste the config from: Firebase Console > Project settings > General > Your apps > Web app > "SDK setup and configuration" (Config).
   Make sure `databaseURL` is included (it appears after you create the Realtime Database).

   These values identify your project; they are not secrets. Your data is protected by the
   Realtime Database security rules (database.rules.json) and the /staff allow-list.

   While apiKey still starts with "YOUR_", the dashboard runs without login or cloud sync. */

window.FIREBASE_CONFIG = {
  apiKey: 'AIzaSyBqXbILQ2nenmY4amChZo-VmqVigadkkQo',
  authDomain: 'patient-monitoring-syste-dae5f.firebaseapp.com',
  databaseURL: 'https://patient-monitoring-syste-dae5f-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId: 'patient-monitoring-syste-dae5f',
  storageBucket: 'patient-monitoring-syste-dae5f.firebasestorage.app',
  messagingSenderId: '177299312062',
  appId: '1:177299312062:web:dca98406889366cfebfdef',
  measurementId: 'G-JEK2VHK2KJ',
};

window.CLOUD_ENABLED = (() => {
  const c = window.FIREBASE_CONFIG || {};
  return !!(c.apiKey && !c.apiKey.startsWith('YOUR_') && c.databaseURL && !c.databaseURL.includes('YOUR_'));
})();
