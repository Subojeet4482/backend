// One-time: copy chat profile fields from main users -> chat DB profiles (+ usernames index).
// run: KEY64_1=... KEY64_2=... node tools/migrate-profiles.mjs   (needs firebase-admin installed)
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
const sa = (k) => cert(JSON.parse(Buffer.from(process.env[k], 'base64').toString()));
const main = getFirestore(initializeApp({ credential: sa('KEY64_1') }, 'm'));
const chat = getFirestore(initializeApp({ credential: sa('KEY64_2') }, 'c'));
const snap = await main.collection('users').get();
let n = 0, w = chat.batch(), ops = 0;
for (const d of snap.docs) {
  const u = d.data(), un = String(u.username || '').toLowerCase();
  w.set(chat.collection('profiles').doc(d.id), { uid: d.id, appName: u.appName || 'Player', username: un, usernameLower: un, bio: u.bio || '', photoUrl: u.photoUrl || u.photoURL || '', coverURL: u.coverURL || '', privacy: u.privacy || 'public', usernameChangesLeft: 3, createdAt: u.createdAt || Date.now() }, { merge: true }); ops++;
  if (un) { w.set(chat.collection('usernames').doc(un), { uid: d.id, at: Date.now() }); ops++; }
  if (ops >= 400) { await w.commit(); w = chat.batch(); ops = 0; }
  n++;
}
if (ops) await w.commit();
console.log('migrated', n, 'profiles');
