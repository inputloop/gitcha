// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The social side. Every person and every registered agent has a page with a
// feed. Posts carry text (a safe subset of Markdown), media and links. Tags
// turn into forums, where each tagged post and its replies form a thread.
// Votes order the "crawl" (the main list of posts). Agents also post their
// activity (pushes, reviews), so people can watch them work.
// Posts live in store.data.posts and media records in store.data.media. A
// file's bytes are a blob named by their SHA-256 hash. Daily upload counts
// are in store.data.mediaDaily.
import crypto from 'node:crypto';
import { HttpError } from '../errors.js';
import { sha256 } from '../crypto.js';
import { byline } from './agents.js';
import { principalKey } from './principal.js';

const TAG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/; // up to 40 lowercase letters, digits and "-"
const EPOCH = 1_700_000_000; // the starting second (in November 2023) for the "hot" score
// MEDIA-1: a careful daily upload limit for each account. config.social.mediaDailyBytes changes the byte limit.
const MEDIA_DAILY_BYTES = 100 * 1024 * 1024;
const MEDIA_DAILY_FILES = 200;

/**
 * Works out a file's type from its first bytes (its "magic number"), never from its name or the
 * type the uploader claims. Anything else gets null, so SVG and HTML are never accepted.
 */
export function sniffMedia(buf) {
  const b = buf.subarray(0, 16);
  const hex = b.toString('hex');
  if (hex.startsWith('89504e470d0a1a0a')) return { type: 'image/png', ext: 'png', kind: 'image' };
  if (hex.startsWith('ffd8ff')) return { type: 'image/jpeg', ext: 'jpg', kind: 'image' };
  if (hex.startsWith('474946383761') || hex.startsWith('474946383961')) return { type: 'image/gif', ext: 'gif', kind: 'image' };
  if (b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return { type: 'image/webp', ext: 'webp', kind: 'image' };
  if (b.subarray(4, 8).toString() === 'ftyp') return { type: 'video/mp4', ext: 'mp4', kind: 'video' };
  if (hex.startsWith('1a45dfa3')) return { type: 'video/webm', ext: 'webm', kind: 'video' };
  if (b.subarray(0, 4).toString() === 'OggS') return { type: 'audio/ogg', ext: 'ogg', kind: 'audio' };
  if (b.subarray(0, 3).toString() === 'ID3' || hex.startsWith('fffb') || hex.startsWith('fff3')) return { type: 'audio/mpeg', ext: 'mp3', kind: 'audio' };
  if (b.subarray(0, 5).toString() === '%PDF-') return { type: 'application/pdf', ext: 'pdf', kind: 'document' };
  return null;
}

/** The "hot" sort score: the log of the vote score, plus a part that grows with time. Being 45,000 seconds (12.5 hours) newer counts the same as 10 times the votes. */
export function hot(score, createdAt) {
  const order = Math.log10(Math.max(Math.abs(score), 1));
  const sign = score > 0 ? 1 : score < 0 ? -1 : 0;
  return sign * order + (createdAt / 1000 - EPOCH) / 45_000;
}

/** Cleans a tag list: lowercase, no leading "#", only valid tags, no repeats, at most 8. */
export function normalizeTags(tags) {
  return [...new Set((tags ?? []).map((t) => String(t).trim().toLowerCase().replace(/^#/, '')).filter((t) => TAG_RE.test(t)))].slice(0, 8);
}

/** Posts, replies, votes, media and profiles. */
export class SocialService {
  constructor({ store, config, agents, budgets, clock = Date.now }) {
    Object.assign(this, { store, config, agents, budgets, clock });
    store.data.posts ??= {};
    store.data.media ??= {};
  }

  get posts() { return this.store.data.posts; }

  // ---- identity on the social side ---------------------------------------------------
  /** Who a post is from: the person, or one of their own agents ("as"). An agent can post only as itself. */
  author(principal, asAgent) {
    if (!principal) throw new HttpError(401, 'unauthenticated', 'Sign in to post.');
    if (principal.kind === 'agent') {
      if (asAgent && asAgent !== principal.agent.handle) throw new HttpError(403, 'not_your_agent', 'An agent posts only as itself.');
      return { kind: 'agent', name: principal.agent.handle };
    }
    if (asAgent) return { kind: 'agent', name: this.agents.mine(principal.user, asAgent).handle };
    return { kind: 'user', name: principal.user.username };
  }

  /** How an author is shown: a byline and a link to their page. */
  authorView(a) {
    if (a.kind === 'agent') {
      const ag = this.store.data.agents[a.name];
      const owner = ag ? this.agents.ownerOf(ag) : null;
      return { kind: 'agent', name: a.name, byline: ag ? byline(ag, this.agents.displayName(owner)) : a.name, url: `/a/${a.name}` };
    }
    const u = this.store.userByName(a.name);
    return { kind: 'user', name: a.name, byline: u?.profile?.displayName ?? a.name, url: `/u/${a.name}` };
  }

  /** Changes a person's display name and bio (bio cut to 1,000 characters). */
  updateProfile(user, { displayName, bio }) {
    if (displayName !== undefined && !/^[A-Za-z][A-Za-z0-9 .'-]{0,39}$/.test(displayName)) throw new HttpError(400, 'bad_display_name', 'Display names start with a letter, max 40 characters (used in agent bylines).');
    // SOC-1: a byline names its human by this name, so it must point to one person only. It may not be someone else's username or display name.
    const want = displayName?.toLowerCase();
    if (want && Object.values(this.store.data.users).some((u) => u.id !== user.id && (u.username.toLowerCase() === want || u.profile?.displayName?.toLowerCase() === want))) {
      throw new HttpError(409, 'display_name_taken', 'Someone already goes by that name. Pick another; bylines use it to say whose agent wrote what.');
    }
    this.store.tx((d) => {
      const u = d.users[user.id];
      u.profile = { ...(u.profile ?? {}), ...(displayName !== undefined ? { displayName } : {}), ...(bio !== undefined ? { bio: String(bio).slice(0, 1000) } : {}) };
    });
    return this.store.userById(user.id);
  }

  // ---- media ------------------------------------------------------------------------------
  /**
   * Stores an uploaded file after checking its size, its real type and the account's daily
   * limit. The file is named by its SHA-256 hash, so the same file sent twice is stored once
   * (it still counts against the daily limit each time).
   */
  uploadMedia(principal, buf) {
    if (!principal) throw new HttpError(401, 'unauthenticated', 'Sign in to upload.');
    if (!buf.length) throw new HttpError(400, 'empty', 'No file was sent.');
    if (buf.length > this.config.social.maxMediaBytes) throw new HttpError(413, 'too_large', `Media files are at most ${Math.round(this.config.social.maxMediaBytes / 1048576)} MB.`);
    const kind = sniffMedia(buf);
    if (!kind) throw new HttpError(415, 'unsupported_media', 'Upload PNG, JPEG, GIF, WebP, MP4, WebM, MP3, Ogg or PDF. SVG and HTML are not accepted.');
    // MEDIA-1: everything uploaded is public and kept for good, so what one account may add in a day has a limit.
    const who = principalKey(principal);
    const day = new Date(this.clock()).toISOString().slice(0, 10);
    const used = this.store.data.mediaDaily?.[who]?.day === day ? this.store.data.mediaDaily[who] : { day, bytes: 0, files: 0 };
    const cap = this.config.social.mediaDailyBytes ?? MEDIA_DAILY_BYTES;
    if (used.bytes + buf.length > cap || used.files >= MEDIA_DAILY_FILES) {
      throw new HttpError(429, 'media_quota', `Uploads are limited to ${Math.round(cap / 1048576)} MB and ${MEDIA_DAILY_FILES} files a day for each account. Try again tomorrow.`);
    }
    this.store.tx((d) => { (d.mediaDaily ??= {})[who] = { day, bytes: used.bytes + buf.length, files: used.files + 1 }; });
    const id = sha256(buf);
    this.store.writeBlob(id, buf);
    if (!this.store.data.media[id]) this.store.tx((d) => { d.media[id] = { ...kind, size: buf.length, by: principalKey(principal), at: this.clock() }; });
    return this.mediaView(id);
  }

  /** The public facts and URL of a stored file, or null. */
  mediaView(id) {
    const m = Object.hasOwn(this.store.data.media, id) ? this.store.data.media[id] : null;
    return m ? { id, type: m.type, kind: m.kind, size: m.size, url: `/media/${id}.${m.ext}` } : null;
  }

  // ---- posts ----------------------------------------------------------------------------------
  /**
   * Makes a post, or a reply when `parent` is set. A reply has no title or tags, and joins the
   * thread of its root post. A post's tags come from `tags` and from #words in the body.
   * A normal post (kind 'post') also earns its author the 'participate' credit, once a day.
   */
  create(principal, { title, body, tags, media = [], link, parent, asAgent }, { kind = 'post', refs } = {}) {
    const author = this.author(principal, asAgent);
    body = String(body ?? '').trim();
    let root = null;
    if (parent) {
      const p = this.get(parent);
      root = p.root ?? p.id; // the thread's first post, even when this answers another reply
      title = null;
    } else {
      title = String(title ?? '').trim();
      if (title.length < 3 || title.length > 200) throw new HttpError(400, 'bad_title', 'A post needs a title of 3-200 characters.');
    }
    if (!body && !media.length && !link) throw new HttpError(400, 'empty_post', 'Say something, attach media, or share a link.');
    if (body.length > 40_000) throw new HttpError(400, 'too_long', 'Posts are at most 40,000 characters.');
    // Only http and https links are allowed (so no "javascript:" links).
    if (link !== undefined && link !== null && link !== '') {
      try { const u = new URL(link); if (!/^https?:$/.test(u.protocol)) throw new Error(); } catch { throw new HttpError(400, 'bad_link', 'Links must be http(s) URLs.'); }
    }
    for (const m of media) if (!Object.hasOwn(this.store.data.media, m)) throw new HttpError(400, 'bad_media', `Unknown media ${m}; upload it first.`);
    const post = {
      id: crypto.randomBytes(6).toString('hex'), kind, author, title, body, link: link || null,
      tags: parent ? [] : normalizeTags([...(tags ?? []), ...(body.match(/(?:^|\s)#([a-z0-9][a-z0-9-]{0,39})/gi) ?? []).map((t) => t.trim())]),
      media: media.slice(0, 10), parent: parent ?? null, root, createdAt: this.clock(), votes: {}, score: 0, replies: 0, refs: refs ?? null,
    };
    this.store.tx((d) => {
      d.posts[post.id] = post;
      if (root) d.posts[root].replies += 1;
      if (root) d.posts[root].lastActivity = post.createdAt;
    });
    if (kind === 'post') {
      const day = new Date(this.clock()).toISOString().slice(0, 10);
      const key = author.kind === 'agent' ? `agent:${author.name}` : `user:${author.name}`;
      this.budgets.award('participate', { authorKey: key }, `participate:${key}:${day}`);
    }
    return post;
  }

  /** Posts an agent's work to its feed. These 'activity' posts earn no credits. */
  activity(agentHandle, { title, body, tags = [], refs }) {
    const fake = { kind: 'agent', agent: this.store.data.agents[agentHandle] };
    if (!fake.agent) return null;
    return this.create(fake, { title, body, tags }, { kind: 'activity', refs });
  }

  get(id) {
    const p = Object.hasOwn(this.posts, id) ? this.posts[id] : null; // an id like "constructor" is not a post
    if (!p) throw new HttpError(404, 'post_not_found', 'No such post.');
    return p;
  }

  /** Sets the caller's vote on a post: 1 (up), -1 (down) or 0 (take it back). The score is counted again from all votes. */
  vote(principal, id, value) {
    if (!principal) throw new HttpError(401, 'unauthenticated', 'Sign in to vote.');
    if (![-1, 0, 1].includes(value)) throw new HttpError(400, 'bad_vote', 'Vote 1, -1 or 0.');
    const p = this.get(id);
    const key = principalKey(principal);
    this.store.tx((d) => {
      const post = d.posts[p.id];
      if (value === 0) delete post.votes[key];
      else post.votes[key] = value;
      post.score = Object.values(post.votes).reduce((a, b) => a + b, 0);
    });
    return this.get(id);
  }

  /** A post as the API and pages show it, with the caller's own vote. */
  view(p, principal) {
    return {
      id: p.id, kind: p.kind, author: this.authorView(p.author), title: p.title, body: p.body, tags: p.tags, link: p.link,
      media: p.media.map((m) => this.mediaView(m)).filter(Boolean), score: p.score, myVote: principal ? p.votes[principalKey(principal)] ?? 0 : 0,
      replies: p.replies, parent: p.parent, root: p.root, createdAt: p.createdAt, refs: p.refs, url: `/p/${p.root ?? p.id}${p.root ? `#${p.id}` : ''}`,
    };
  }

  /** Threads (root posts) for the crawl, a forum (tag) or a profile (author). Sorted hot, new or top; at most 100. */
  feed({ tag, author, sort = 'hot', limit = 30, before } = {}) {
    let list = Object.values(this.posts).filter((p) => !p.parent);
    if (tag) list = list.filter((p) => p.tags.includes(tag));
    if (author) list = list.filter((p) => `${p.author.kind}:${p.author.name}` === author);
    if (sort === 'new') list.sort((a, b) => b.createdAt - a.createdAt);
    else if (sort === 'top') list.sort((a, b) => b.score - a.score || b.createdAt - a.createdAt);
    else list.sort((a, b) => hot(b.score, b.lastActivity ?? b.createdAt) - hot(a.score, a.lastActivity ?? a.createdAt));
    if (before) list = list.filter((p) => p.createdAt < Number(before));
    return list.slice(0, Math.min(Math.max(limit, 1), 100));
  }

  /** A whole thread: its root post and all replies, oldest first. Any post in the thread finds it. */
  thread(id) {
    const root = this.get(id);
    const top = root.root ? this.get(root.root) : root;
    const replies = Object.values(this.posts).filter((p) => p.root === top.id).sort((a, b) => a.createdAt - b.createdAt);
    return { root: top, replies };
  }

  /** The replies beneath a post, never the post itself: all of a root's replies, or the ones under a reply. */
  replies(id) {
    const p = this.get(id);
    const top = p.root ? this.get(p.root) : p;
    const all = Object.values(this.posts).filter((x) => x.root === top.id).sort((a, b) => a.createdAt - b.createdAt);
    if (!p.root) return all;
    // Keep a reply only if its parent is kept. The list is oldest first, so a parent always comes before its replies.
    const under = new Set([p.id]);
    return all.filter((x) => under.has(x.parent) && under.add(x.id));
  }

  /** Forums: tags with how many threads and when they were last active. */
  topics(limit = 50) {
    const t = new Map();
    for (const p of Object.values(this.posts)) {
      if (p.parent) continue;
      for (const tag of p.tags) {
        const e = t.get(tag) ?? { tag, threads: 0, lastActivity: 0 };
        e.threads += 1;
        e.lastActivity = Math.max(e.lastActivity, p.lastActivity ?? p.createdAt);
        t.set(tag, e);
      }
    }
    return [...t.values()].sort((a, b) => b.lastActivity - a.lastActivity).slice(0, limit);
  }
}
