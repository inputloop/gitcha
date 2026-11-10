// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com>
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The Messages page, in the browser. This file only draws the page. The work is done by two files shared
// with the gitcha CLI: dm-client.js (this device's keys, envelopes and contacts) and dm-protocol.js (the
// encryption). Keys and opened messages are kept in this browser's IndexedDB; the keys as Web Crypto objects
// the page can use but cannot read out.
//
// Text from other people is only ever put on the page with textContent, never as HTML.
import { DmDevice } from './dm-client.js';

const root = document.getElementById('dm');
const ME = root.dataset.me;
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) { if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); }
  for (const k of kids) e.append(k);
  return e;
};
const when = (t) => new Date(t).toLocaleString();

function showError(err) {
  const box = $('dm-error');
  if (!err) { box.hidden = true; return; }
  box.replaceChildren(document.createTextNode(err.message ?? String(err)));
  if (err.verify) box.append(' ', el('a', { href: err.verify, text: 'Confirm it is you' }));
  box.hidden = false;
}

/** Call /api/v1/dm on this server with the session and the page's CSRF token. A due 2FA check links to /verify. */
async function api(method, path, body) {
  const res = await fetch(`/api/v1/dm${path}`, {
    method, credentials: 'same-origin',
    headers: { 'X-Gitcha-CSRF': root.dataset.csrf, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error === 'mfa_required' ? 'Confirm it is you to continue.' : data.message ?? `The server answered ${res.status}.`);
    err.code = data.error;
    if (data.error === 'mfa_required') err.verify = `/verify?reason=${encodeURIComponent(data.reason ?? 'sensitive_action')}&next=${encodeURIComponent(location.pathname + location.search)}`;
    throw err;
  }
  return data;
}

// This browser's storage: one IndexedDB store, with names kept apart per site and per person.
const db = new Promise((resolve, reject) => {
  const r = indexedDB.open('gitcha-dm-v2', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
const kv = async (mode, fn) => {
  const d = await db;
  return new Promise((resolve, reject) => {
    const t = d.transaction('kv', mode);
    const req = fn(t.objectStore('kv'));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
};
const prefix = `${location.origin}:${ME}:`;
const storage = { get: (n) => kv('readonly', (s) => s.get(prefix + n)), put: (n, v) => kv('readwrite', (s) => s.put(v, prefix + n)) };

const device = new DmDevice({ me: ME, api, storage, mode: 'cryptokey' });
let current = null; // the username of the open conversation
const show = (id) => { $('dm-loading').hidden = true; for (const s of ['dm-setup', 'dm-restore', 'dm-main']) $(s).hidden = s !== id; };

const RESTORE_WHY = {
  changed: 'Your messaging key was replaced on another device (or by someone else). Unlock the current keys with the backup passphrase, or make new ones.',
  'new-device': 'This browser does not have your messaging keys yet. Unlock them with your backup passphrase.',
  'no-backup': 'This browser does not have your messaging keys, and no backup is stored. You can make new keys; messages sent to the old ones cannot be read with them.',
  'other-device': 'Another of your devices made a new key for incoming messages. Unlock with your backup passphrase to read them here too.',
};

async function start() {
  // Browsers give a page the encryption tools (Web Crypto) only over https or on localhost. On a plain-http
  // address such as http://192.168.1.20:4873 they are missing, so say that instead of failing on the first key.
  if (!window.isSecureContext || !globalThis.crypto?.subtle) {
    $('dm-loading').hidden = true;
    return showError(new Error('Encrypted messages need https, or http://localhost on this computer. Your browser does not allow the encryption they use on a plain-http address like this one.'));
  }
  try {
    showError(null);
    const st = await device.status();
    if (st.state === 'setup') return show('dm-setup');
    if (st.state === 'restore') { $('dm-restore-why').textContent = RESTORE_WHY[st.reason] ?? ''; return show('dm-restore'); }
    $('dm-my-fp').textContent = device.keys.identity.fingerprint.slice(0, 16);
    show('dm-main');
    await device.sync();
    drawConversations();
    if (root.dataset.to && !current) await openThread(root.dataset.to);
  } catch (err) { showError(err); }
}

function drawConversations() {
  const convs = device.conversations();
  $('dm-conversations').replaceChildren(...(convs.length ? convs.map((c) => el('li', {},
    el('button', { class: `dm-conv${c.with === current ? ' active' : ''}`, type: 'button', onclick: () => openThread(c.with).catch(showError) },
      el('strong', { text: c.with }), c.unread ? el('span', { class: 'badge', text: `${c.unread} new` }) : '', el('span', { class: 'small muted', text: when(c.last) })))) : [el('li', { class: 'muted small', text: 'No conversations yet.' })]));
}

async function openThread(username) {
  showError(null);
  current = username;
  const pane = $('dm-thread');
  const c = await device.contact(username);
  if (!c.ready) {
    pane.replaceChildren(el('h2', { text: username }), el('p', { class: 'muted', text: `${username} has not set up encrypted messages yet. Ask them to open Messages once.` }));
    return drawConversations();
  }
  const notes = [];
  if (c.pin === 'new') notes.push(el('p', { class: 'small muted', text: `First conversation with ${username}: compare the safety number below with them to be sure.` }));
  if (c.pin === 'changed') {
    notes.push(el('div', { class: 'alert error', role: 'alert' },
      `${username}'s key has changed since you last wrote. This happens when they set up new keys, but it would also happen if someone tried to read your messages. Check the new safety number with ${username} before you send anything. `,
      el('button', { class: 'btn small', type: 'button', text: 'I checked it', onclick: async () => { await device.acceptKey(username); openThread(username).catch(showError); } })));
  }
  if (!c.prekeyOk) notes.push(el('div', { class: 'alert error', role: 'alert', text: `${username}'s current prekey is not signed by their key, so nothing will be sent to it.` }));

  const list = el('ol', { class: 'dm-messages' });
  for (const m of device.thread(username)) {
    list.append(el('li', { class: `dm-msg ${m.out ? 'out' : 'in'}${m.trusted ? '' : ' failed'}` },
      el('p', { text: m.text }),
      el('span', { class: 'small muted', text: `${m.out ? 'You' : username}, ${when(m.at)}${m.trusted ? '' : ' (signed by a key you have not confirmed)'}` })));
  }
  const lost = device.failures().length;
  const box = el('textarea', { name: 'text', rows: '3', maxlength: '20000', required: '', 'aria-label': `Message to ${username}`, placeholder: `Write to ${username}` });
  const form = el('form', { class: 'dm-compose', onsubmit: async (e) => {
    e.preventDefault();
    const text = box.value;
    if (!text.trim()) return;
    try { await device.send(username, text); box.value = ''; await openThread(username); } catch (err) { showError(err); }
  } }, box, el('button', { class: 'btn', text: 'Send encrypted' }));
  const safety = el('details', { class: 'dm-safety' }, el('summary', { text: 'Safety number' }),
    el('p', { class: 'dm-number', text: c.safety }),
    el('p', { class: 'small muted', text: `${username} sees the same number when they open this conversation. If yours match, no one is in between.` }));
  const isBlocked = (device.server?.blocked ?? []).includes(username);
  const block = el('button', { class: 'btn ghost small', type: 'button', text: isBlocked ? `Unblock ${username}` : `Block ${username}`,
    onclick: async () => { await device.block(username, !isBlocked); device.server = await api('GET', '/me'); openThread(username).catch(showError); } });
  pane.replaceChildren(el('div', { class: 'dm-thread-head' }, el('h2', { text: username }), block), ...notes, safety,
    list.childElementCount ? list : el('p', { class: 'muted', text: 'No messages yet.' }),
    lost ? el('p', { class: 'small muted', text: `${lost} message(s) to you could not be opened on this device (their keys were destroyed, or they were damaged).` }) : '',
    isBlocked ? el('p', { class: 'muted', text: `You blocked ${username}. Unblock them to write.` })
      : c.pin === 'changed' || !c.prekeyOk ? el('p', { class: 'muted', text: 'Sending is off until the key is checked.' }) : form);
  list.lastElementChild?.scrollIntoView({ block: 'nearest' });
  await device.markRead(username);
  drawConversations();
}

$('dm-setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const pass = f.get('passphrase'), again = f.get('again');
  if (pass && pass.length < 12) return showError(new Error('The passphrase must be at least 12 characters (or empty for no backup).'));
  if (pass !== again) return showError(new Error('The two passphrases do not match.'));
  try { showError(null); await device.setup(pass || null); await start(); } catch (err) { showError(err); }
});
$('dm-restore-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { showError(null); await device.restore(new FormData(e.target).get('passphrase')); await start(); } catch (err) { showError(err); }
});
$('dm-replace').addEventListener('click', () => show('dm-setup'));
$('dm-new').addEventListener('submit', (e) => {
  e.preventDefault();
  const to = new FormData(e.target).get('to').trim();
  if (to) openThread(to).catch(showError);
});
// New messages: look again every 15 seconds while the page is in view, but never while something is being
// typed (redrawing the conversation would lose it).
setInterval(async () => {
  const typing = document.activeElement?.closest?.('.dm-compose, .dm-new') || [...document.querySelectorAll('.dm-compose textarea')].some((t) => t.value);
  if (document.visibilityState !== 'visible' || typing || $('dm-main').hidden) return;
  try { if (await device.sync()) (current ? openThread(current) : drawConversations()); } catch { /* try again next time */ }
}, 15_000);
start();
