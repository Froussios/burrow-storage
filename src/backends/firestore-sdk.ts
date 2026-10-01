// The slice of the modular Firebase SDK the adapter uses (FS-3: firebase/firestore only, no auth).
export { deleteApp, getApps, initializeApp } from "firebase/app";
export {
  connectFirestoreEmulator, doc, getDocFromServer, getFirestore, onSnapshot, runTransaction,
} from "firebase/firestore";
