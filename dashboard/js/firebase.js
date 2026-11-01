/* Shared Firebase setup (ES module) for the login, patient-list and monitor pages.
   Loaded only when firebase-config.js is filled in.

   Accounts:
     /users/{uid}     { role: 'doctor' | 'patient', name, email, createdAt }
     /doctors/{uid}   created at sign-up with the clinic's registration code (checked by the database rules)
     /staff/{uid}     true = doctor approved manually by an admin in the console (no code needed)
     /patients/{uid}  patient profile; the patient's uid is also the key for their vitals and alerts */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendPasswordResetEmail, signOut, updateProfile, deleteUser,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  getDatabase, ref, get, set, push, update, onValue, onChildAdded,
  query, orderByChild, startAt, endAt, limitToLast,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js';

export const app = initializeApp(window.FIREBASE_CONFIG);
export const auth = getAuth(app);
export const db = getDatabase(app);

export {
  onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendPasswordResetEmail, signOut, updateProfile, deleteUser,
  ref, get, set, push, update, onValue, onChildAdded, query, orderByChild, startAt, endAt, limitToLast,
};

/* Loads the signed-in user's profile and whether they are a verified doctor.
   Throws if the database can't be reached. */
export async function loadAccount(user) {
  const opt = (p) => get(ref(db, p)).catch(() => null);
  const [profile, doctor, staff] = await Promise.all([
    get(ref(db, `users/${user.uid}`)),
    opt(`doctors/${user.uid}`),
    opt(`staff/${user.uid}`),
  ]);
  const isStaff = !!(staff && staff.val() === true);
  return {
    profile: profile.val(),
    staff: isStaff,
    verifiedDoctor: isStaff || !!(doctor && doctor.exists()),
  };
}

export const homeFor = (account) => (account.profile.role === 'doctor' ? 'patients.html' : 'index.html');

export const isPermissionError = (e) => /permission.denied/i.test((e && (e.code || e.message)) || '');

/* Readable reason for a failed account load. */
export const accountErrorText = (e) => isPermissionError(e)
  ? 'The database refused access. Publish the latest database.rules.json in the Firebase console (Realtime Database → Rules).'
  : 'Could not load your account: ' + e.message;

/* One-shot message passed to the login page across a redirect. */
export function setAuthNotice(notice) {
  try {
    sessionStorage.setItem('pm.authNotice', JSON.stringify(notice));
  } catch {}
}

export function takeAuthNotice() {
  try {
    const v = sessionStorage.getItem('pm.authNotice');
    sessionStorage.removeItem('pm.authNotice');
    return v ? JSON.parse(v) : null;
  } catch {
    return null;
  }
}
