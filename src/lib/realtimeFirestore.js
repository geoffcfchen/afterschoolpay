import { getFirestore } from "firebase/firestore";
import { app } from "./firebase";

export const realtimeFirestore = app ? getFirestore(app) : undefined;
