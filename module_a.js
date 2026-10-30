<script type="module">
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  setPersistence,
  browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  collection,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp,
  terminate,
  clearIndexedDbPersistence
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyC7ga-g3XzF1Tmwm2_9FGK7T-jkwEbP6-0",
  authDomain: "fathers-finance.firebaseapp.com",
  projectId: "fathers-finance",
  storageBucket: "fathers-finance.firebasestorage.app",
  messagingSenderId: "531387408583",
  appId: "1:531387408583:web:f07f205a715379428b5ee2",
  measurementId: "G-F8ZYNMDYYS"
};

// Initialize Firebase exactly once per page load.
const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
// Firestore with an offline cache shared by this browser's tabs. Writes made offline are queued and synced later.
const db = initializeFirestore(firebaseApp, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

const MIN_PASSWORD_LENGTH = 10;
const $ = id => document.getElementById(id);
const ui = {
  loading: $("authLoading"),
  screen: $("authScreen"),
  app: $("appShell"),
  message: $("authMessage"),
  tabSignIn: $("tabSignIn"),
  tabRegister: $("tabRegister"),
  signInForm: $("signInForm"),
  registerForm: $("registerForm"),
  signInEmail: $("signInEmail"),
  signInPassword: $("signInPassword"),
  signInSubmit: $("signInSubmit"),
  registerEmail: $("registerEmail"),
  registerPassword: $("registerPassword"),
  registerConfirm: $("registerConfirm"),
  registerSubmit: $("registerSubmit"),
  signOutBtn: $("signOutBtn"),
  accountEmail: $("accountEmail"),
  protectionStatus: $("protectionStatus")
};

// Human-friendly messages for Firebase Auth error codes.
// Wrong email and wrong password share one message so the form does not reveal which accounts exist.
const AUTH_ERRORS = {
  "auth/invalid-email": "That email address is not valid.",
  "auth/missing-email": "Please enter your email address.",
  "auth/missing-password": "Please enter your password.",
  "auth/invalid-credential": "Incorrect email or password.",
  "auth/invalid-login-credentials": "Incorrect email or password.",
  "auth/wrong-password": "Incorrect email or password.",
  "auth/user-not-found": "Incorrect email or password.",
  "auth/user-disabled": "This account has been disabled.",
  "auth/email-already-in-use": "An account already exists for this email. Try signing in instead.",
  "auth/weak-password": "This password is too weak. Use at least 10 characters with letters and numbers.",
  "auth/operation-not-allowed": "Sign-in is temporarily unavailable. Please try again later.",
  "auth/too-many-requests": "Too many attempts. Please wait a few minutes and try again.",
  "auth/network-request-failed": "Network error. Check your internet connection and try again.",
  "auth/internal-error": "Something went wrong. Please try again."
};

let authBusy = false;

function friendlyAuthError(err) {
  const code = err && err.code;
  // Log only the error code, never the email or password.
  console.warn("Firebase Auth error:", code || "unknown");
  return AUTH_ERRORS[code] || "Sign-in could not be completed. Please try again.";
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

// Returns an error message, or an empty string when the password is acceptable.
function passwordProblem(password) {
  if (password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return "Password must include at least one letter and one number.";
  return "";
}

function showAuthMessage(text, type = "error") {
  ui.message.textContent = text;
  ui.message.className = `auth-message ${type}`;
}

function clearAuthMessage() {
  ui.message.textContent = "";
  ui.message.className = "auth-message hidden";
}

function clearPasswordFields() {
  ui.signInPassword.value = "";
  ui.registerPassword.value = "";
  ui.registerConfirm.value = "";
}

function setAuthMode(mode) {
  const signIn = mode === "signin";
  ui.tabSignIn.classList.toggle("active", signIn);
  ui.tabRegister.classList.toggle("active", !signIn);
  ui.tabSignIn.setAttribute("aria-selected", String(signIn));
  ui.tabRegister.setAttribute("aria-selected", String(!signIn));
  ui.signInForm.classList.toggle("hidden", !signIn);
  ui.registerForm.classList.toggle("hidden", signIn);
  clearAuthMessage();
}

// Disables the submit button while Firebase works, then restores it.
async function runAuthAction(button, busyText, action) {
  if (authBusy) return;
  authBusy = true;
  const idleText = button.dataset.label;
  button.disabled = true;
  button.textContent = busyText;
  try {
    await action(); // onAuthStateChanged switches the screen on success.
  } catch (err) {
    showAuthMessage(friendlyAuthError(err));
  } finally {
    authBusy = false;
    button.disabled = false;
    button.textContent = idleText;
  }
}

function showApp(user) {
  ui.loading.classList.add("hidden");
  ui.screen.classList.add("hidden");
  ui.app.classList.remove("hidden");
  ui.accountEmail.textContent = `Signed in as ${user.email || "owner account"}`;
  ui.protectionStatus.textContent = "Signed in";
  ui.protectionStatus.className = "tag green";
  clearPasswordFields();
  clearAuthMessage();
}

function showAuthScreen() {
  ui.loading.classList.add("hidden");
  ui.app.classList.add("hidden");
  ui.screen.classList.remove("hidden");
  ui.accountEmail.textContent = "";
  ui.protectionStatus.textContent = "Not signed in";
  ui.protectionStatus.className = "tag amber";
  clearPasswordFields();
}

// Keep the session across browser restarts.
setPersistence(auth, browserLocalPersistence).catch(err => {
  console.error("Could not set session persistence:", err && err.code);
});

// Removes this browser's copy of the owner's data (offline cache) at sign-out, so a shared computer keeps no records.
async function wipeLocalData() {
  try {
    await terminate(db);
    await clearIndexedDbPersistence(db);
  } catch (err) {
    console.warn("Local data cleanup incomplete:", err && err.code);
  }
}

let currentUid = null;
let signedInOnce = false;

// Runs on page load and whenever the sign-in state changes. The dashboard stays hidden until this has run.
onAuthStateChanged(auth, async user => {
  document.body.dataset.authReady = "1";
  if (user) {
    // Switching accounts in the same page is unsafe. Reload so no state from the previous user survives.
    if (currentUid && currentUid !== user.uid) {
      location.reload();
      return;
    }
    const firstSignIn = !currentUid;
    currentUid = user.uid;
    signedInOnce = true;
    showApp(user);
    if (firstSignIn) startDataForUser(user.uid);
  } else {
    showAuthScreen();
    stopListeners();
    if (signedInOnce) {
      await wipeLocalData();
      location.reload();
    }
  }
});

ui.tabSignIn.addEventListener("click", () => setAuthMode("signin"));
ui.tabRegister.addEventListener("click", () => setAuthMode("register"));

ui.signInForm.addEventListener("submit", e => {
  e.preventDefault();
  clearAuthMessage();
  const email = ui.signInEmail.value.trim();
  const password = ui.signInPassword.value;
  if (!isValidEmail(email)) return showAuthMessage("Please enter a valid email address.");
  if (!password) return showAuthMessage("Please enter your password.");
  runAuthAction(ui.signInSubmit, "Signing in…", () => signInWithEmailAndPassword(auth, email, password));
});

ui.registerForm.addEventListener("submit", e => {
  e.preventDefault();
  clearAuthMessage();
  const email = ui.registerEmail.value.trim();
  const password = ui.registerPassword.value;
  const confirm = ui.registerConfirm.value;
  if (!isValidEmail(email)) return showAuthMessage("Please enter a valid email address.");
  const problem = passwordProblem(password);
  if (problem) return showAuthMessage(problem);
  if (password !== confirm) return showAuthMessage("The passwords do not match.");
  runAuthAction(ui.registerSubmit, "Creating account…", () => createUserWithEmailAndPassword(auth, email, password));
});

ui.signOutBtn.addEventListener("click", async () => {
  if (hasUnsyncedChanges() && !confirm("Some changes have not reached the server yet. Signing out now may lose them. Sign out anyway?")) {
    return;
  }
  ui.signOutBtn.disabled = true;
  try {
    await signOut(auth); // The auth listener above clears local data and returns to the sign-in screen.
  } catch (err) {
    console.error("Sign-out failed:", err && err.code);
    ui.signOutBtn.disabled = false;
    toast("Could not sign out. Check your internet connection and try again.");
  }
});
