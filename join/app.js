// Group Draw "join in your browser" page — reuses the exact same Firestore
// data model, auth, and rules as the Hoof Picks mobile app
// (see /Users/rc/Documents/Hoof-Picks/lib/firebase.ts + lib/groupDraws.ts).
// This file intentionally duplicates that logic in plain JS rather than
// importing it, since this is a zero-build static page with no bundler.

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, onSnapshot, collection, query, orderBy,
  updateDoc, getDocs, where,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

// Same public web config as lib/firebase.ts — safe to expose client-side,
// access control is enforced by firestore.rules, not by keeping this secret.
const firebaseConfig = {
  apiKey: 'AIzaSyDdvXr9Y5n3ebQxmGUDEq2wFpPPFdoJ_JQ',
  authDomain: 'hoof-picks.firebaseapp.com',
  projectId: 'hoof-picks',
  storageBucket: 'hoof-picks.firebasestorage.app',
  messagingSenderId: '858111240988',
  appId: '1:858111240988:web:b4e1316b5a3220ebcbe8d9',
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// --- ensureSignedIn(): mirrors lib/firebase.ts's memoized anonymous sign-in ---
let signInPromise = null;
function ensureSignedIn() {
  if (auth.currentUser) return Promise.resolve(auth.currentUser.uid);
  if (!signInPromise) {
    signInPromise = new Promise((resolve, reject) => {
      const unsub = onAuthStateChanged(auth, user => {
        if (user) { unsub(); resolve(user.uid); }
      }, reject);
      signInAnonymously(auth).catch(reject);
    });
  }
  return signInPromise;
}

const drawRef = code => doc(db, 'draws', code.toUpperCase());
const entriesCol = code => collection(db, 'draws', code.toUpperCase(), 'entries');
const entryRef = (code, number) => doc(db, 'draws', code.toUpperCase(), 'entries', String(number));

const toDraw = (id, data) => ({
  code: id,
  hostId: data.hostId,
  title: data.title,
  min: data.min,
  max: data.max,
  status: data.status,
  winningNumber: data.winningNumber ?? null,
  maxPerParticipant: data.maxPerParticipant ?? null,
  createdAt: data.createdAt,
});

// --- subscribeToDraw(): mirrors lib/groupDraws.ts's dual-listener pattern ---
function subscribeToDraw(code, onUpdate) {
  let currentDraw = null, currentEntries = [];
  let drawLoaded = false, entriesLoaded = false, cancelled = false;
  let unsubDraw = null, unsubEntries = null;

  const maybeEmit = () => { if (drawLoaded && entriesLoaded) onUpdate(currentDraw, currentEntries); };

  // A listener started before sign-in resolves gets a terminal
  // permission-denied from the rules and won't retry on its own — so wait
  // for ensureSignedIn() before attaching, same as the mobile app.
  ensureSignedIn().then(() => {
    if (cancelled) return;
    unsubDraw = onSnapshot(drawRef(code), snap => {
      currentDraw = snap.exists() ? toDraw(snap.id, snap.data()) : null;
      drawLoaded = true;
      maybeEmit();
    });
    unsubEntries = onSnapshot(query(entriesCol(code), orderBy('number')), snap => {
      currentEntries = snap.docs.map(d => d.data());
      entriesLoaded = true;
      maybeEmit();
    });
  }).catch(() => onUpdate(undefined, [])); // undefined = sign-in itself failed (offline, etc.)

  return () => { cancelled = true; unsubDraw?.(); unsubEntries?.(); };
}

// --- claimEntry(): mirrors lib/groupDraws.ts's claim flow + rule constraints ---
async function claimEntry(code, number, label) {
  const trimmed = label.trim();
  if (!trimmed) return { ok: false, reason: 'invalid-label' };

  const me = await ensureSignedIn();
  const drawSnap = await getDoc(drawRef(code));
  if (!drawSnap.exists()) return { ok: false, reason: 'not-found' };
  const drawData = drawSnap.data();
  if (drawData.status === 'locked') return { ok: false, reason: 'locked' };

  const max = drawData.maxPerParticipant;
  if (typeof max === 'number') {
    const mineSnap = await getDocs(query(entriesCol(code), where('claimedBy', '==', me)));
    if (mineSnap.size >= max) return { ok: false, reason: 'limit-reached' };
  }

  try {
    await updateDoc(entryRef(code, number), {
      label: trimmed.slice(0, 20),
      claimedBy: me,
      claimedAt: new Date().toISOString(),
    });
    return { ok: true };
  } catch {
    const entrySnap = await getDoc(entryRef(code, number));
    if (!entrySnap.exists()) return { ok: false, reason: 'not-found' };
    const entryData = entrySnap.data();
    if (entryData.claimedBy || entryData.label) return { ok: false, reason: 'taken' };
    return { ok: false, reason: 'locked' };
  }
}

// --- Rendering ---

const appEl = document.getElementById('app');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function renderLoading() {
  appEl.innerHTML = `<div class="card"><p class="muted">Loading…</p></div>`;
}

function renderCodeEntry(errorMsg) {
  appEl.innerHTML = `
    <div class="card">
      <p class="title">Join a Group Draw</p>
      <p class="sub">Enter the code your host shared with you.</p>
      <form class="code-form" id="code-entry-form">
        <input type="text" id="code-entry-input" placeholder="e.g. 7K4QXM" maxlength="6" autocapitalize="characters" autocomplete="off">
        <button type="submit">Go</button>
      </form>
      ${errorMsg ? `<p class="error">${esc(errorMsg)}</p>` : ''}
    </div>`;
  document.getElementById('code-entry-form').addEventListener('submit', e => {
    e.preventDefault();
    const v = document.getElementById('code-entry-input').value.trim().toUpperCase();
    if (v) location.search = `?code=${encodeURIComponent(v)}`;
  });
}

function renderNotFound(code) {
  appEl.innerHTML = `
    <div class="card">
      <p class="title">Draw not found</p>
      <p class="sub">No draw found for code "${esc(code)}" — double check the link and try again.</p>
    </div>`;
}

function renderOffline() {
  appEl.innerHTML = `<div class="card"><p class="error">Couldn't connect. Check your connection and reload the page.</p></div>`;
}

function entryStatus(e, me) {
  const taken = !!e.claimedBy || !!e.label;
  return { taken, mine: taken && e.claimedBy === me };
}

function renderOpen(code, draw, entries, me, state) {
  const rows = entries.map(e => {
    const { taken, mine } = entryStatus(e, me);
    if (state.claimingNumber === e.number) {
      return `
        <div class="row">
          <span class="num">#${e.number}</span>
          <form class="claim-form" data-claim-submit="${e.number}">
            <input type="text" maxlength="20" placeholder="Your name" id="claim-input" autofocus>
            <button type="submit">Claim</button>
            <button type="button" class="secondary" data-claim-cancel="1">Cancel</button>
          </form>
        </div>`;
    }
    if (taken) {
      return `
        <div class="row taken ${mine ? 'mine' : ''}">
          <span class="num">#${e.number}</span>
          <span class="label">${esc(e.label)}</span>
          ${mine ? '<span class="you-tag">You</span>' : ''}
        </div>`;
    }
    return `
      <div class="row">
        <span class="num">#${e.number}</span>
        <span class="label muted">Open</span>
        <button class="tap-claim" data-claim-start="${e.number}">Tap to claim</button>
      </div>`;
  }).join('');

  appEl.innerHTML = `
    <div class="card">
      <p class="title">${esc(draw.title)}</p>
      <p class="sub">Numbers ${draw.min}–${draw.max} · code <strong>${esc(code)}</strong></p>
      ${state.error ? `<p class="error">${esc(state.error)}</p>` : ''}
    </div>
    <div class="card">${rows}</div>`;

  appEl.querySelectorAll('[data-claim-start]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.claimingNumber = Number(btn.dataset.claimStart);
      state.error = '';
      renderOpen(code, draw, entries, me, state);
    });
  });
  const form = appEl.querySelector('[data-claim-submit]');
  if (form) {
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const number = Number(form.dataset.claimSubmit);
      const value = document.getElementById('claim-input').value;
      const result = await claimEntry(code, number, value);
      if (result.ok) {
        state.claimingNumber = null;
        state.error = '';
        // The live onSnapshot update will re-render with fresh data; this
        // just clears the inline form immediately for responsiveness.
      } else if (result.reason === 'taken') state.error = 'Someone just claimed that number — pick another.';
      else if (result.reason === 'locked') state.error = 'This draw has already been generated.';
      else if (result.reason === 'limit-reached') state.error = `You've already claimed the maximum number of picks for this draw.`;
      else state.error = 'Enter a name before claiming.';
      if (!result.ok) state.claimingNumber = number;
      renderOpen(code, draw, state.lastEntries ?? entries, me, state);
    });
    appEl.querySelector('[data-claim-cancel]').addEventListener('click', () => {
      state.claimingNumber = null;
      state.error = '';
      renderOpen(code, draw, entries, me, state);
    });
  }
}

function renderLocked(code, draw, entries) {
  const winner = entries.find(e => e.number === draw.winningNumber);
  const rows = entries.map(e => {
    const isWinner = e.number === draw.winningNumber;
    const { taken } = entryStatus(e, null);
    return `
      <div class="row ${isWinner ? 'winner' : ''}">
        <span class="num">#${e.number}</span>
        <span class="label">${taken ? esc(e.label) : 'Unclaimed'}</span>
        ${isWinner ? '<span class="winner-tag">Winner</span>' : ''}
      </div>`;
  }).join('');

  appEl.innerHTML = `
    <div class="card">
      <p class="title">${esc(draw.title)}</p>
      <p class="sub">Draw is over</p>
      <div class="winner-box">
        <div class="num">${draw.winningNumber}</div>
        ${winner && winner.label ? `<div class="label">${esc(winner.label)}</div>` : ''}
      </div>
      <p class="get-app">Want to host your own? Get the app — <a href="https://apps.apple.com/us/app/hoof-picks/id6811161449">iPhone</a> · <a href="https://play.google.com/store/apps/details?id=com.hoofpicks.app">Android</a>.</p>
    </div>
    <div class="card">${rows}</div>`;
}

function renderCancelled(draw) {
  appEl.innerHTML = `
    <div class="card">
      <p class="title">${esc(draw.title)}</p>
      <p class="sub">This draw was cancelled by the host.</p>
    </div>`;
}

// --- Entry point ---

function init() {
  const code = new URLSearchParams(location.search).get('code')?.trim().toUpperCase();
  if (!code) { renderCodeEntry(); return; }

  renderLoading();
  const state = { claimingNumber: null, error: '', lastEntries: [] };
  let me = '';
  ensureSignedIn().then(uid => { me = uid; });

  subscribeToDraw(code, (draw, entries) => {
    if (draw === undefined) { renderOffline(); return; }
    state.lastEntries = entries;
    // Don't clobber an in-progress claim input on a live update from
    // someone else's action — just buffer the latest data (state.lastEntries
    // above) and re-render once the user finishes or cancels their claim.
    if (state.claimingNumber !== null) return;

    if (draw === null) { renderNotFound(code); return; }
    if (draw.status === 'open') renderOpen(code, draw, entries, me, state);
    else if (draw.status === 'locked') renderLocked(code, draw, entries);
    else if (draw.status === 'cancelled') renderCancelled(draw);
  });
}

init();
