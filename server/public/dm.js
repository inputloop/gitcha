// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The Messages page, in the browser. Everything secret happens here, with the browser's own cryptography
// (Web Crypto), so the Gitcha server only ever stores public keys and ciphertext.
//
//   Keys      An ECDH key pair on the P-256 curve. The private key is kept in this browser (IndexedDB) as a
//             key the page can use but not read out. A locked copy may be stored on the server: the key is
//             encrypted with AES-GCM under a key made from your passphrase (PBKDF2-SHA256, 600,000 rounds).
//   Messages  Both people's keys give the same shared secret (ECDH). HKDF turns it into an AES-256-GCM key.
//             Each message has a fresh 12-byte IV, and the names and keys of both people are bound to it (as
//             "additional data"), so the server cannot pass a message off as from someone else.
//   Trust     The first key seen for a person is remembered here ("trust on first use"). If it changes, the page
//             says so. The safety number lets two people check, outside Gitcha, that they see the same keys.
//
// Text from other people is only ever put on the page with textContent, never as HTML.

const root = document.getElementById('dm');
const ME = root.dataset.me;
const $ = (id) => document.getElementById(id);
const enc = new TextEncoder(), dec = new TextDecoder();
const subtle = crypto.subtle;
const ITERATIONS = 600_000;
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };

// ---- small helpers ---------------------------------------------------------------------------------------
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
const el = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) { if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); }
  for (const k of kids) e.append(k);
  return e;
};
const when = (t) => new Date(t).toLocaleString();

function showError(text, link) {
  const box = $('dm-error');
  box.replaceChildren(document.createTextNode(text));
  if (link) box.append(' ', el('a', { href: link.href, text: link.text }));
  box.hidden = !text;
}

/** Call the server. A 2FA check that is due sends the person to confirm it, then back here. */
async function api(method, path, body) {
  const res = await fetch(`/api/v1/dm${path}`, {
    method, credentials: 'same-origin',
    headers: { 'X-Gitcha-CSRF': root.dataset.csrf, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.error === 'mfa_required') {
    const err = new Error('Confirm it is you to continue.');
    err.verify = `/verify?reason=${encodeURIComponent(data.reason ?? 'sensitive_action')}&next=${encodeURIComponent(location.pathname + location.search)}`;
    throw err;
  }
  if (!res.ok) throw new Error(data.message ?? `The server answered ${res.status}.`);
  return data;
}

// ---- this browser's storage (IndexedDB) ------------------------------------------------------------------
const db = new Promise((resolve, reject) => {
  const r = indexedDB.open('gitcha-dm', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
async function kv(mode, fn) {
  const d = await db;
  return new Promise((resolve, reject) => {
    const t = d.transaction('kv', mode);
    const req = fn(t.objectStore('kv'));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}
const keyName = `key:${location.origin}:${ME}`;
const pinName = `pins:${location.origin}:${ME}`;
const loadLocal = () => kv('readonly', (s) => s.get(keyName));
const saveLocal = (v) => kv('readwrite', (s) => s.put(v, keyName));
const loadPins = async () => (await kv('readonly', (s) => s.get(pinName))) ?? {};
const savePins = (v) => kv('readwrite', (s) => s.put(v, pinName));

// ---- keys ------------------------------------------------------------------------------------------------
/** A public key's fingerprint, computed the same way as the server: SHA-256 of "P-256:x:y". */
const fingerprint = async (jwk) => hex(await subtle.digest('SHA-256', enc.encode(`P-256:${jwk.x}:${jwk.y}`)));
const publicPart = (jwk) => ({ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y });

/** Lock (or unlock) with a key made from a passphrase. */
async function passKey(passphrase, salt, iterations) {
  const base = await subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Make a new key pair, keep the private key here (not readable out), and send the public key and the optional locked backup. */
async function makeKey(passphrase) {
  const pair = await subtle.generateKey(ECDH, true, ['deriveBits']);
  const pub = publicPart(await subtle.exportKey('jwk', pair.publicKey));
  const pkcs8 = await subtle.exportKey('pkcs8', pair.privateKey);
  let backup = null;
  if (passphrase) {
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = enc.encode(JSON.stringify({ pkcs8: b64(pkcs8), publicKey: pub }));
    const data = await subtle.encrypt({ name: 'AES-GCM', iv }, await passKey(passphrase, salt, ITERATIONS), plain);
    backup = { v: 1, kdf: 'PBKDF2-SHA256', cipher: 'AES-GCM', iterations: ITERATIONS, salt: b64(salt), iv: b64(iv), data: b64(data) };
  }
  const fp = await fingerprint(pub);
  const server = await api('PUT', '/key', { publicKey: pub, backup });
  if (server.fingerprint !== fp) throw new Error('The server stored a different key from the one this browser made. Nothing was saved here.');
  const privateKey = await subtle.importKey('pkcs8', pkcs8, ECDH, false, ['deriveBits']);
  await saveLocal({ privateKey, publicKey: pub, fingerprint: fp });
  return server;
}

/** Unlock the stored backup with the passphrase, and keep the key in this browser. */
async function restoreKey(passphrase) {
  const { backup, fingerprint: fp } = await api('GET', '/backup');
  let inner;
  try {
    const plain = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(backup.iv) }, await passKey(passphrase, unb64(backup.salt), backup.iterations), unb64(backup.data));
    inner = JSON.parse(dec.decode(plain));
  } catch { throw new Error('That passphrase does not unlock the backup.'); }
  if (await fingerprint(inner.publicKey) !== fp) throw new Error('The backup does not hold your current key. It was made for an older key.');
  const privateKey = await subtle.importKey('pkcs8', unb64(inner.pkcs8), ECDH, false, ['deriveBits']);
  await saveLocal({ privateKey, publicKey: inner.publicKey, fingerprint: fp });
}

const conversationKeys = new Map();
/** The AES-GCM key two people share: ECDH of my private key and their public key, then HKDF. */
async function conversationKey(mine, theirJwk, theirFp) {
  const id = `${mine.fingerprint}:${theirFp}`;
  if (!conversationKeys.has(id)) {
    const pub = await subtle.importKey('jwk', publicPart(theirJwk), ECDH, false, []);
    const bits = await subtle.deriveBits({ name: 'ECDH', public: pub }, mine.privateKey, 256);
    const hk = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
    const info = enc.encode(`gitcha dm v1|${[mine.fingerprint, theirFp].sort().join('|')}`);
    conversationKeys.set(id, await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('gitcha-dm-v1'), info }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']));
  }
  return conversationKeys.get(id);
}
// Who sent it to whom, with which keys: bound to the ciphertext, so the server cannot relabel a message.
const boundData = (m) => enc.encode(JSON.stringify(['gitcha-dm-v1', m.from, m.to, m.fromKey, m.toKey]));

/** The safety number for two keys: 12 groups of 5 digits, the same for both people. */
async function safetyNumber(fpA, fpB) {
  const d = new Uint8Array(await subtle.digest('SHA-256', enc.encode([fpA, fpB].sort().join(':'))));
  const groups = [];
  for (let i = 0; i < 12; i++) groups.push(String(((d[i * 2] << 8) | d[i * 2 + 1]) % 100000).padStart(5, '0'));
  return groups.join(' ');
}

// ---- the page --------------------------------------------------------------------------------------------
let mine = null;
let current = null; // the username of the open conversation
const show = (id) => { for (const s of ['dm-setup', 'dm-restore', 'dm-main']) $(s).hidden = s !== id; };

async function start() {
  try {
    const server = await api('GET', '/me');
    const local = await loadLocal();
    if (!server.fingerprint) return show('dm-setup');
    if (!local || local.fingerprint !== server.fingerprint) {
      $('dm-restore-why').textContent = local
        ? 'Your messaging key was changed on another device (or by someone else). Unlock the current key with its backup passphrase, or make a new one.'
        : server.hasBackup ? 'This browser does not have your messaging key yet. Unlock it with your backup passphrase.'
          : 'This browser does not have your messaging key, and no backup is stored. You can make a new key; messages sent to the old one cannot be read with it.';
      return show('dm-restore');
    }
    mine = local;
    $('dm-my-fp').textContent = mine.fingerprint.slice(0, 16);
    show('dm-main');
    await loadConversations();
    if (root.dataset.to) await openThread(root.dataset.to);
  } catch (err) { showError(err.message, err.verify ? { href: err.verify, text: 'Confirm it is you' } : null); }
}

async function loadConversations() {
  const { conversations } = await api('GET', '/conversations');
  $('dm-conversations').replaceChildren(...(conversations.length ? conversations.map((c) => el('li', {},
    el('button', { class: `dm-conv${c.with === current ? ' active' : ''}`, type: 'button', onclick: () => openThread(c.with) },
      el('strong', { text: c.with }), c.unread ? el('span', { class: 'badge', text: `${c.unread} new` }) : '', el('span', { class: 'small muted', text: when(c.last) })))) : [el('li', { class: 'muted small', text: 'No conversations yet.' })]));
}

async function openThread(username) {
  showError('');
  current = username;
  const t = await api('GET', `/with/${encodeURIComponent(username)}`);
  const pane = $('dm-thread');
  if (!t.with.fingerprint) {
    pane.replaceChildren(el('h2', { text: username }), el('p', { class: 'muted', text: `${username} has not set up encrypted messages yet. Ask them to open Messages once.` }));
    return loadConversations();
  }
  // The fingerprint is computed here, from the very key this page will encrypt to. The server's own
  // fingerprint must agree; a server that sent one key with another key's fingerprint is refused.
  const theirFp = await fingerprint(t.with.publicKey);
  if (theirFp !== t.with.fingerprint) {
    pane.replaceChildren(el('h2', { text: username }), el('div', { class: 'alert error', role: 'alert', text: `The server sent a key for ${username} that does not match its own fingerprint. Nothing will be sent.` }));
    return;
  }
  // Trust on first use: remember the first key seen for this person, and say so plainly when it changes.
  const pins = await loadPins();
  const pinned = pins[username];
  const changed = Boolean(pinned) && pinned !== theirFp;
  const notes = [];
  if (!pinned) { pins[username] = theirFp; await savePins(pins); notes.push(el('p', { class: 'small muted', text: `First conversation with ${username}: compare the safety number below with them to be sure.` })); }
  else if (changed) {
    notes.push(el('div', { class: 'alert error', role: 'alert' },
      `${username}'s key has changed since you last wrote. This happens when they set up a new device or lost their key, but it would also happen if someone tried to read your messages. Check the new safety number with ${username} before you send anything private. `,
      el('button', { class: 'btn small', type: 'button', onclick: async () => { pins[username] = theirFp; await savePins(pins); openThread(username); }, text: 'I checked it' })));
  }
  const keyOf = (fp) => t.with.history.find((h) => h.fingerprint === fp)?.publicKey;
  const list = el('ol', { class: 'dm-messages' });
  for (const m of t.messages) {
    const outgoing = m.from === ME;
    let text, failed = false;
    const myFp = outgoing ? m.fromKey : m.toKey, theirFp = outgoing ? m.toKey : m.fromKey;
    try {
      if (myFp !== mine.fingerprint) throw new Error('This message used your old key, which this browser does not have.');
      const jwk = keyOf(theirFp);
      if (!jwk || await fingerprint(jwk) !== theirFp) throw new Error('The sender\'s key for this message is not known.');
      const key = await conversationKey(mine, jwk, theirFp);
      text = dec.decode(await subtle.decrypt({ name: 'AES-GCM', iv: unb64(m.iv), additionalData: boundData(m) }, key, unb64(m.ct)));
    } catch (err) { failed = true; text = err.name === 'OperationError' ? 'This message could not be decrypted: it was changed, or it was not written for this key.' : err.message; }
    list.append(el('li', { class: `dm-msg ${outgoing ? 'out' : 'in'}${failed ? ' failed' : ''}` }, el('p', { text }), el('span', { class: 'small muted', text: `${outgoing ? 'You' : username}, ${when(m.at)}` })));
  }
  const box = el('textarea', { name: 'text', rows: '3', maxlength: '8000', required: '', 'aria-label': `Message to ${username}`, placeholder: `Write to ${username}` });
  const form = el('form', { class: 'dm-compose', onsubmit: async (e) => {
    e.preventDefault();
    try { await send(t, box.value); box.value = ''; await openThread(username); } catch (err) { showError(err.message, err.verify ? { href: err.verify, text: 'Confirm it is you' } : null); }
  } }, box, el('button', { class: 'btn', text: 'Send encrypted' }));
  const safety = el('details', { class: 'dm-safety' }, el('summary', { text: 'Safety number' }),
    el('p', { class: 'dm-number', text: await safetyNumber(mine.fingerprint, theirFp) }),
    el('p', { class: 'small muted', text: `${username} sees the same number when they open this conversation. If yours match, no one is in between.` }));
  const block = el('button', { class: 'btn ghost small', type: 'button', text: t.blocked ? `Unblock ${username}` : `Block ${username}`, onclick: async () => { await api('POST', '/block', { username, blocked: !t.blocked }); openThread(username); } });
  pane.replaceChildren(el('div', { class: 'dm-thread-head' }, el('h2', { text: username }), block), ...notes, safety,
    t.messages.length ? list : el('p', { class: 'muted', text: 'No messages yet.' }),
    t.blocked ? el('p', { class: 'muted', text: `You blocked ${username}. Unblock them to write.` })
      : changed ? el('p', { class: 'muted', text: 'Sending is off until you have checked the new key.' }) : form);
  list.lastElementChild?.scrollIntoView({ block: 'nearest' });
  await loadConversations();
}

/** Encrypt and send one message to the open conversation. */
async function send(t, text) {
  if (!text.trim()) return;
  const msg = { from: ME, to: t.with.username, fromKey: mine.fingerprint, toKey: t.with.fingerprint };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await conversationKey(mine, t.with.publicKey, t.with.fingerprint);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: boundData(msg) }, key, enc.encode(text));
  await api('POST', '/send', { to: msg.to, iv: b64(iv), ct: b64(ct), fromKey: msg.fromKey, toKey: msg.toKey });
}

$('dm-setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const pass = f.get('passphrase'), again = f.get('again');
  if (pass && pass.length < 12) return showError('The passphrase must be at least 12 characters (or empty for no backup).');
  if (pass !== again) return showError('The two passphrases do not match.');
  try { showError(''); await makeKey(pass || null); await start(); } catch (err) { showError(err.message, err.verify ? { href: err.verify, text: 'Confirm it is you' } : null); }
});
$('dm-restore-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { showError(''); await restoreKey(new FormData(e.target).get('passphrase')); await start(); } catch (err) { showError(err.message, err.verify ? { href: err.verify, text: 'Confirm it is you' } : null); }
});
$('dm-replace').addEventListener('click', () => { show('dm-setup'); });
$('dm-new').addEventListener('submit', (e) => {
  e.preventDefault();
  const to = new FormData(e.target).get('to').trim();
  if (to) openThread(to).catch((err) => showError(err.message));
});
// New messages: look again every 15 seconds while the page is in view, but never while something is being
// typed (redrawing the conversation would lose it).
setInterval(() => {
  const typing = document.activeElement?.closest?.('.dm-compose, .dm-new') || [...document.querySelectorAll('.dm-compose textarea')].some((t) => t.value);
  if (document.visibilityState === 'visible' && mine && !typing) (current ? openThread(current) : loadConversations()).catch(() => {});
}, 15_000);
start();
