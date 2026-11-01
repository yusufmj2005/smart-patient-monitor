import {
  auth, db, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendPasswordResetEmail, signOut, updateProfile, deleteUser, ref, update,
  loadAccount, homeFor, isPermissionError, accountErrorText, setAuthNotice, takeAuthNotice,
} from './firebase.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const msg = $('#authMsg');

const ERRORS = {
  'auth/invalid-credential': 'Incorrect email or password.',
  'auth/invalid-email': 'Enter a valid email address.',
  'auth/missing-password': 'Enter your password.',
  'auth/user-disabled': 'This account has been disabled.',
  'auth/too-many-requests': 'Too many attempts. Wait a few minutes, or reset your password.',
  'auth/network-request-failed': 'No connection to Firebase. Check your internet connection.',
  'auth/operation-not-allowed': 'Email/password sign-in is not enabled in the Firebase console.',
  'auth/email-already-in-use': 'An account with this email already exists. Sign in instead.',
  'auth/weak-password': 'Password must be at least 6 characters.',
};
const errText = (e) => ERRORS[e.code] || e.message;

let mode = 'signin';        // 'signin' | 'register' | 'complete'
let busy = false;           // a submit handler is doing its own routing
let completeAcct = null;    // account being completed (signed in, no profile yet)

// ---------- UI helpers ----------

function show(text, kind = 'error') {
  msg.hidden = !text;
  msg.dataset.kind = kind;
  msg.textContent = text || '';
}

function setMode(m) {
  mode = m;
  $('#authTabs').hidden = m === 'complete';
  $$('#authTabs [role="tab"]').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.mode === m)));
  $('#signinForm').hidden = m !== 'signin';
  $('#registerForm').hidden = m === 'signin';
  $('#completeIntro').hidden = m !== 'complete';
  $('#accountFields').hidden = m === 'complete';
  $('#btnCompleteSignOut').hidden = m !== 'complete';
  $('#btnRegister').textContent = m === 'complete' ? 'Continue' : 'Create account';
  $('#authCard').classList.toggle('wide', m !== 'signin');
  document.title = (m === 'signin' ? 'Sign in' : 'Create account') + ' · Patient Monitor';
  updateRoleFields();
}

function selectedRole() {
  const r = $('input[name="role"]:checked');
  return r ? r.value : null;
}

function updateRoleFields() {
  const role = selectedRole();
  $$('[data-role-fields]').forEach((el) => (el.hidden = el.dataset.roleFields !== role));
  // Doctors approved by an admin (/staff) don't need the registration code.
  $('#codeField').hidden = mode === 'complete' && completeAcct && completeAcct.staff;
}

function setBusy(button, on, label) {
  button.disabled = on;
  if (on) {
    button.dataset.label = button.textContent;
    button.textContent = label;
  } else if (button.dataset.label) {
    button.textContent = button.dataset.label;
  }
}

// ---------- Routing ----------

async function route(user) {
  let acct;
  try {
    acct = await loadAccount(user);
  } catch (e) {
    setMode('signin');
    show(accountErrorText(e));
    return;
  }
  if (!acct.profile) {
    completeAcct = acct;
    $('#completeEmail').textContent = user.email;
    show('');
    setMode('complete');
    return;
  }
  if (acct.profile.role === 'doctor' && !acct.verifiedDoctor) {
    show('This doctor account has not been verified.');
    await signOut(auth);
    return;
  }
  location.replace(homeFor(acct));
}

onAuthStateChanged(auth, (user) => {
  $('#loadingNote').hidden = true;
  if (!user) {
    completeAcct = null;
    if (mode === 'complete') setMode('signin');
    else setMode(mode);
    return;
  }
  if (!busy) route(user);
});

const notice = takeAuthNotice();
if (notice) {
  const text = {
    'signed-out': ['You have been signed out.', 'info'],
    'not-verified': ['This doctor account has not been verified.', 'error'],
    'no-patient': ['Your patient record could not be found. Contact the clinic.', 'error'],
  }[notice.code];
  if (text) show(...text);
}

// ---------- Sign in ----------

$('#signinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#siEmail').value.trim();
  const password = $('#siPassword').value;
  if (!email || !password) return show('Enter your email and password.');
  show('');
  busy = true;
  setBusy($('#btnSignIn'), true, 'Signing in…');
  try {
    const { user } = await signInWithEmailAndPassword(auth, email, password);
    await route(user);
  } catch (err) {
    show(errText(err));
  } finally {
    busy = false;
    setBusy($('#btnSignIn'), false);
  }
});

$('#btnReset').addEventListener('click', async () => {
  const email = $('#siEmail').value.trim();
  if (!email) {
    $('#siEmail').focus();
    return show('Enter your email above, then click "Forgot password?" again.', 'info');
  }
  try {
    await sendPasswordResetEmail(auth, email);
    show(`If an account exists for ${email}, a password reset link is on its way.`, 'info');
  } catch (err) {
    show(errText(err));
  }
});

// ---------- Create account ----------

function readRegistration() {
  const role = selectedRole();
  const d = {
    role,
    name: $('#rgName').value.trim(),
    email: $('#rgEmail').value.trim(),
    password: $('#rgPassword').value,
    confirm: $('#rgConfirm').value,
    specialty: $('#rgSpecialty').value.trim(),
    code: $('#rgCode').value.trim(),
    age: $('#rgAge').value === '' ? null : Number($('#rgAge').value),
    gender: $('#rgGender').value,
    phone: $('#rgPhone').value.trim(),
    caregiverEmail: $('#rgCaregiver').value.trim(),
  };
  if (!role) return [d, 'Choose Doctor or Patient.'];
  if (!d.name) return [d, 'Enter your full name.'];
  if (mode === 'register') {
    if (!d.email) return [d, 'Enter your email.'];
    if (d.password.length < 6) return [d, 'Password must be at least 6 characters.'];
    if (d.password !== d.confirm) return [d, 'Passwords do not match.'];
  }
  if (role === 'doctor' && !d.code && !(completeAcct && completeAcct.staff)) return [d, 'Enter the doctor registration code.'];
  if (role === 'patient') {
    if (d.age == null || !Number.isFinite(d.age) || d.age < 0 || d.age > 130) return [d, 'Enter a valid age.'];
    if (!d.gender) return [d, 'Select a gender.'];
  }
  return [d, null];
}

const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v != null));

/* Writes the profile in one atomic multi-path update so the rules can check it as a whole. */
async function writeProfile(user, d) {
  const now = Date.now();
  const updates = {
    [`users/${user.uid}`]: clean({ role: d.role, name: d.name, email: user.email, createdAt: now }),
  };
  if (d.role === 'doctor') {
    if (!(completeAcct && completeAcct.staff)) {
      updates[`doctors/${user.uid}`] = clean({ name: d.name, specialty: d.specialty, code: d.code, createdAt: now });
    }
  } else {
    updates[`patients/${user.uid}`] = clean({
      name: d.name, email: user.email, age: d.age, gender: d.gender, phone: d.phone,
      caregiverEmail: d.caregiverEmail, createdAt: now,
    });
  }
  await update(ref(db), updates);
}

$('#registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const [d, problem] = readRegistration();
  if (problem) return show(problem);
  show('');
  busy = true;
  const btn = $('#btnRegister');
  setBusy(btn, true, mode === 'complete' ? 'Saving…' : 'Creating account…');

  let user = auth.currentUser;
  let created = false;
  try {
    if (mode === 'register') {
      ({ user } = await createUserWithEmailAndPassword(auth, d.email, d.password));
      created = true;
      updateProfile(user, { displayName: d.name }).catch(() => {});
    }
    await writeProfile(user, d);
    location.replace(d.role === 'doctor' ? 'patients.html' : 'index.html');
  } catch (err) {
    if (created) {
      // Profile was rejected: remove the half-created login so the email can be used again.
      await deleteUser(user).catch(() => signOut(auth));
    }
    if (isPermissionError(err)) {
      show(d.role === 'doctor'
        ? 'The doctor registration code is incorrect. Check it with the clinic administrator.'
        : 'The database refused this account. Check that the latest database rules are published.');
    } else {
      show(errText(err));
    }
  } finally {
    busy = false;
    setBusy(btn, false);
  }
});

$('#btnCompleteSignOut').addEventListener('click', () => signOut(auth));

// ---------- Misc ----------

$('#authTabs').addEventListener('click', (e) => {
  const m = e.target.dataset && e.target.dataset.mode;
  if (!m || m === mode) return;
  show('');
  setMode(m);
});

$$('input[name="role"]').forEach((r) => r.addEventListener('change', updateRoleFields));

$$('.pw-toggle').forEach((b) =>
  b.addEventListener('click', () => {
    const input = document.getElementById(b.dataset.for);
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    b.textContent = reveal ? 'Hide' : 'Show';
    b.setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
  }));

if (location.hash === '#register') setMode('register');
