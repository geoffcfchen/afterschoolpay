import { initializeApp, getApps, getApp } from "firebase/app";
import { getAnalytics, isSupported } from "firebase/analytics";
import {
  createUserWithEmailAndPassword,
  fetchSignInMethodsForEmail,
  getAuth,
  GoogleAuthProvider,
  sendEmailVerification,
  signInWithEmailAndPassword,
  signInWithPopup,
} from "firebase/auth";
import { getFirestore } from "firebase/firestore/lite";
import { getStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FB_API_KEY,
  authDomain: import.meta.env.VITE_FB_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FB_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FB_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FB_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FB_APP_ID,
  measurementId: import.meta.env.VITE_FB_MEASUREMENT_ID,
};

export const hasFirebaseConfig = [
  firebaseConfig.apiKey,
  firebaseConfig.authDomain,
  firebaseConfig.projectId,
  firebaseConfig.appId,
].every(Boolean);

const requireFirebase = (service) => {
  if (!hasFirebaseConfig || !service) {
    throw new Error(
      "Firebase is not configured. Add your VITE_FB_* values to .env.local and GitHub Secrets.",
    );
  }

  return service;
};

const app = hasFirebaseConfig
  ? getApps().length
    ? getApp()
    : initializeApp(firebaseConfig)
  : undefined;

let analytics;
if (app && typeof window !== "undefined") {
  isSupported()
    .then((supported) => {
      if (supported) {
        analytics = getAnalytics(app);
      }
    })
    .catch(() => {
      analytics = undefined;
    });
}

export const auth = app ? getAuth(app) : undefined;
export const firestore = app ? getFirestore(app) : undefined;
export const storage = app ? getStorage(app) : undefined;
export { analytics, app };

export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({
  prompt: "select_account",
});

export async function signIn(email, password) {
  try {
    await signInWithEmailAndPassword(requireFirebase(auth), email, password);
    return true;
  } catch (error) {
    console.error("Email sign in failed:", error);
    return false;
  }
}

export async function signUp(email, password) {
  const userCredential = await createUserWithEmailAndPassword(
    requireFirebase(auth),
    email,
    password,
  );

  if (userCredential.user) {
    await sendEmailVerification(userCredential.user);
  }

  return userCredential;
}

export async function signInWithGoogle() {
  try {
    const result = await signInWithPopup(requireFirebase(auth), googleProvider);
    return result.user;
  } catch (error) {
    if (error.code === "auth/popup-closed-by-user") {
      return null;
    }

    console.error("Google sign in failed:", error);
    throw error;
  }
}

export async function getSignInMethods(email) {
  if (!email) {
    return [];
  }

  return fetchSignInMethodsForEmail(requireFirebase(auth), email);
}
