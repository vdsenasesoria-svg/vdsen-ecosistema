// Firebase Auth double for the VDSEN Image Upload harness. Never touches the network.
//
// Auth state is mutable and observable so the acceptance can sign in, sign out and switch coaches in
// the SAME tab, exactly like the real SDK notifies onAuthStateChanged subscribers on each transition.
//
//   window.__VDSEN_HARNESS_AUTH__.signIn('coach.alfa@harness.invalid')
//   window.__VDSEN_HARNESS_AUTH__.signOut()
//   window.__VDSEN_HARNESS_AUTH__.current()   -> uid | null
const listeners = [];
let current = null;
let booted = false;

const FIX = () => (typeof window !== 'undefined' && window.__VDSEN_FIXTURE__) || {};
const CREDS = () => FIX().creds || {};

function makeUser(uid) {
  const entry = Object.entries(CREDS()).find(([, c]) => c.uid === uid);
  const coach = (FIX().coaches || {})[uid] || {};
  if (!entry && FIX().client && FIX().client.uid === uid) {
    const c = FIX().client;
    return { uid, email: (c.data && c.data.email) || 'cliente.prueba@harness.invalid', displayName: (c.data && c.data.displayName) || 'Cliente Prueba', providerData: [{ providerId: 'password' }], emailVerified: true };
  }
  return {
    uid,
    email: entry ? entry[0] : (coach.email || 'coach@harness.invalid'),
    displayName: (entry && entry[1].displayName) || coach.displayName || 'Coach',
    providerData: [{ providerId: 'password' }],
    emailVerified: true,
  };
}

function notify() {
  const u = current ? makeUser(current) : null;
  for (const cb of listeners.slice()) { try { cb(u); } catch (e) { /* un listener no debe romper a los demas */ } }
}

function boot() {
  if (booted) return;
  booted = true;
  if (typeof window !== 'undefined') {
    window.__VDSEN_HARNESS_AUTH__ = {
      signIn(email) {
        const c = CREDS()[email];
        if (!c) throw new Error('unknown harness credential: ' + email);
        current = c.uid;
        notify();
        return c.uid;
      },
      signInUid(uid) { current = uid; notify(); return uid; },
      signOut() { current = null; notify(); },
      current: () => current,
      emails: () => Object.keys(CREDS()),
    };
  }
  const f = FIX();
  if (f.client && f.client.uid) current = f.client.uid;
}

export function getAuth() { boot(); return { currentUser: current ? makeUser(current) : null, __harness: true }; }
export function onAuthStateChanged(_auth, cb) {
  boot();
  listeners.push(cb);
  setTimeout(() => { try { cb(current ? makeUser(current) : null); } catch (e) { /* ignore */ } }, 0);
  return () => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); };
}
export async function signInWithEmailAndPassword(_auth, email) {
  boot();
  const c = CREDS()[email];
  if (!c) throw Object.assign(new Error('auth/user-not-found'), { code: 'auth/user-not-found' });
  current = c.uid;
  notify();
  return { user: makeUser(current) };
}
export async function signOut() { boot(); current = null; notify(); return undefined; }
// The coach app imports these too. A module missing ANY named export fails to LOAD at all - the
// browser raises SyntaxError before executing a single line.
export async function updatePassword() { return undefined; }
export async function reauthenticateWithCredential() { return { user: current ? makeUser(current) : null }; }
export async function createUserWithEmailAndPassword(_auth, email, _pass) {
  boot();
  const c = CREDS()[email];
  if (c) { current = c.uid; notify(); return { user: makeUser(current) }; }
  current = 'harness-created-' + String(email).split('@')[0];
  notify();
  return { user: makeUser(current) };
}
export const EmailAuthProvider = {
  credential(email, password) { return { __harness: 'credential', email, password }; },
};
export async function sendPasswordResetEmail() { return undefined; }
export async function setPersistence() { return undefined; }
export function browserLocalPersistence() { return 'local'; }
export function indexedDBLocalPersistence() { return 'indexeddb'; }
export function inMemoryPersistence() { return 'memory'; }
export function getRedirectResult() { return Promise.resolve(null); }
export default { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, updatePassword, reauthenticateWithCredential, createUserWithEmailAndPassword, EmailAuthProvider, sendPasswordResetEmail, setPersistence, browserLocalPersistence };
