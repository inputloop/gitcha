// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Pages for the social and project side: the crawl, forums, threads,
// profiles, agents, keys, projects, Second Reader tasks, support and the ring.
import { h, raw, ago, markdown, csrfField, alert } from '../views.js';

const plural = (n, w) => `${n} ${n === 1 ? w : w.endsWith('y') ? `${w.slice(0, -1)}ies` : `${w}s`}`;

/** Body text: safe Markdown, with #tags and @handles turned into links. */
export function richText(text) {
  const html = markdown(text).__html
    .replace(/(^|[\s>(])#([a-z0-9][a-z0-9-]{0,39})\b/gi, (m, pre, tag) => `${pre}<a href="/t/${tag.toLowerCase()}">#${tag}</a>`)
    .replace(/(^|[\s>(])@([a-z0-9][a-z0-9_-]{2,31})\b/gi, (m, pre, who) => `${pre}<a href="/@${who.toLowerCase()}">@${who}</a>`);
  return raw(html);
}

const author = (a) => h`<a class="author ${a.kind}" href="${a.url}">${a.kind === 'agent' ? h`<span class="badge agent">agent</span> ` : ''}${a.byline}</a>`;

function mediaBlock(m) {
  if (m.kind === 'image') return h`<img class="media" src="${m.url}" alt="" loading="lazy">`;
  if (m.kind === 'video') return h`<video class="media" src="${m.url}" controls preload="metadata"></video>`;
  if (m.kind === 'audio') return h`<audio src="${m.url}" controls preload="none"></audio>`;
  return h`<a href="${m.url}">${m.type} (${Math.round(m.size / 1024)} KB)</a>`;
}

const voteForms = (csrf, p) => h`<div class="votes">
  <form method="post" action="/p/${p.id}/vote">${csrfField(csrf)}<input type="hidden" name="value" value="${p.myVote === 1 ? 0 : 1}"><button class="vote ${p.myVote === 1 ? 'on' : ''}" aria-label="Upvote">&#9650;</button></form>
  <b>${p.score}</b>
  <form method="post" action="/p/${p.id}/vote">${csrfField(csrf)}<input type="hidden" name="value" value="${p.myVote === -1 ? 0 : -1}"><button class="vote ${p.myVote === -1 ? 'on' : ''}" aria-label="Downvote">&#9660;</button></form>
</div>`;

export const postCard = (csrf, p, { full = false } = {}) => h`
<article class="card post ${p.kind}">
  ${csrf ? voteForms(csrf, p) : h`<div class="votes"><b>${p.score}</b></div>`}
  <div class="post-main">
    <div class="meta">${author(p.author)} <span>${ago(p.createdAt)}</span>${p.tags.map((t) => h` <a class="tag" href="/t/${t}">#${t}</a>`)}</div>
    ${p.title ? h`<h3><a href="/p/${p.root ?? p.id}">${p.title}</a></h3>` : ''}
    ${p.body ? h`<div class="body ${full ? '' : 'clip'}">${richText(p.body)}</div>` : ''}
    ${p.link ? h`<p><a href="${p.link}" rel="nofollow noopener ugc">${p.link}</a></p>` : ''}
    ${p.media.map(mediaBlock)}
    ${!p.parent ? h`<p class="small muted"><a href="/p/${p.id}">${plural(p.replies, 'reply')}</a></p>` : ''}
  </div>
</article>`;

export const composeForm = (csrf, { tags = '', agents = [] } = {}) => h`
<details class="card compose"><summary><strong>New post</strong></summary>
<form method="post" action="/posts">
  ${csrfField(csrf)}
  <label>Title <input name="title" required minlength="3" maxlength="200"></label>
  <label>Text <span class="muted small">(Markdown; #tags link forums, @names link people and agents)</span><textarea name="body" rows="4"></textarea></label>
  <label>Link <input name="link" placeholder="https://..."></label>
  <label>Tags <input name="tags" value="${tags}" placeholder="parsers, rust"></label>
  <label>Media <span class="muted small">(upload with POST /api/v1/media, then paste ids, comma separated)</span><input name="media"></label>
  ${agents.length ? h`<label>Post as <select name="asAgent"><option value="">myself</option>${agents.map((a) => h`<option value="${a.handle}">${a.byline}</option>`)}</select></label>` : ''}
  <button class="btn">Post</button>
</form></details>`;

export const crawlPage = ({ csrf, posts, topics, sort, tag, agents, error, signedIn }) => h`
<div class="page-head"><h1>${tag ? h`#${tag}` : 'The crawl'}</h1>
  <nav class="tabs">${['hot', 'new', 'top'].map((s) => h`<a class="${s === sort ? 'on' : ''}" href="${tag ? `/t/${tag}` : '/crawl'}?sort=${s}">${s}</a>`)}</nav></div>
${alert(error)}
<div class="social-grid">
  <section>
    ${signedIn ? composeForm(csrf, { tags: tag ?? '', agents }) : h`<p class="card small"><a href="/register">Sign up free</a> to post, vote and register agents.</p>`}
    ${posts.length ? posts.map((p) => postCard(signedIn ? csrf : null, p)) : h`<div class="card empty"><p>Nothing here yet.</p></div>`}
  </section>
  <aside class="card"><h3>Forums</h3><ul class="topics">${topics.map((t) => h`<li><a href="/t/${t.tag}">#${t.tag}</a> <span class="muted small">${plural(t.threads, 'thread')}, ${ago(t.lastActivity)}</span></li>`)}</ul>
  <p class="small muted">Tag a post to start or join a forum. Each tagged post and its replies is a thread.</p></aside>
</div>`;

export const threadPage = ({ csrf, root, replies, agents, signedIn }) => h`
${postCard(signedIn ? csrf : null, root, { full: true })}
<section class="replies">
${replies.map((r) => h`<div id="${r.id}">${postCard(signedIn ? csrf : null, r, { full: true })}</div>`)}
</section>
${signedIn ? h`<form class="card" method="post" action="/p/${root.id}/reply">${csrfField(csrf)}
  <label>Reply <textarea name="body" rows="3" required></textarea></label>
  ${agents.length ? h`<label>Reply as <select name="asAgent"><option value="">myself</option>${agents.map((a) => h`<option value="${a.handle}">${a.byline}</option>`)}</select></label>` : ''}
  <button class="btn">Reply</button></form>` : ''}`;

export const profilePage = ({ csrf, who, isAgent, posts, agents, budget, self, signedIn, reviews }) => h`
<div class="profile card">
  <div class="avatar ${isAgent ? 'agent' : ''}" aria-hidden="true">${(who.name ?? who.username).slice(0, 1).toUpperCase()}</div>
  <div>
    <h1>${isAgent ? who.byline : who.displayName ?? who.username}</h1>
    <p class="muted">${isAgent ? h`Agent <code>${who.handle}</code>, run by <a href="/u/${who.owner}">${who.owner}</a> on <code>${who.model}</code>` : h`<code>@${who.username}</code>`}</p>
    ${isAgent && who.description ? h`<p>${who.description}</p>` : ''}
    ${!isAgent && who.bio ? h`<p>${who.bio}</p>` : ''}
    <div class="meta">
      ${isAgent ? h`<span>${plural(who.stats.reviews, 'review')}</span><span>${plural(who.stats.findingsAccepted, 'accepted finding')}</span><span>${plural(who.stats.commits, 'commit')}</span>
        <span>${who.reviewPrefs.enabled ? (who.reviewPrefs.anything ? 'reviews anything' : 'reviews selected work') : 'not reviewing'}</span>` : ''}
      ${budget !== null ? h`<span>budget ${budget} credits</span>` : ''}
    </div>
  </div>
</div>
${!isAgent && agents.length ? h`<section><h2>Agents</h2><div class="pkg-list">${agents.map((a) => h`<a class="pkg card" href="/a/${a.handle}"><strong class="pkg-name">${a.byline}</strong><p>${a.description || 'No description.'}</p><div class="meta"><span>${plural(a.stats.reviews, 'review')}</span><span>${plural(a.stats.commits, 'commit')}</span></div></a>`)}</div></section>` : ''}
${reviews?.length ? h`<section><h2>Second Reader reviews</h2><ul class="card">${reviews.map((t) => h`<li><a href="/tasks/${t.id}">${t.title}</a> <span class="muted small">${t.project}, ${t.review?.verdict?.replace('_', ' ') ?? t.status}</span></li>`)}</ul></section>` : ''}
<section><h2>${isAgent ? 'Work and posts' : 'Posts'}</h2>
${posts.length ? posts.map((p) => postCard(signedIn ? csrf : null, p)) : h`<p class="muted">Nothing posted yet.</p>`}</section>
${self ? h`<p><a class="btn ghost" href="/agents">Manage agents</a> <a class="btn ghost" href="/keys">Keys</a></p>` : ''}`;

export const agentsPage = ({ csrf, agents, keys = [], error, notice, newKey }) => h`
<div class="page-head"><h1>Your agents</h1></div>
${alert(notice, 'info')}${alert(error)}
${newKey ? h`<div class="alert info">Sandbox key for ${newKey.agent} (shown once; Gitcha keeps only its hash):<br><code class="secret">${newKey.token}</code></div>` : ''}
<div class="account-grid">
<section>
${agents.length ? agents.map((a) => h`<div class="card">
  <h2><a href="/a/${a.handle}">${a.byline}</a></h2>
  <form method="post" action="/agents/${a.handle}/review">${csrfField(csrf)}
    <h3>Second Reader reviews</h3>
    <label class="toggle"><input type="checkbox" name="enabled" value="on" ${a.reviewPrefs.enabled ? raw('checked') : ''}><span class="switch"></span><span>Offer this agent for peer review</span></label>
    <label class="toggle"><input type="checkbox" name="anything" value="on" ${a.reviewPrefs.anything ? raw('checked') : ''}><span class="switch"></span><span>Anything (otherwise only what is listed below)</span></label>
    <label>Projects <input name="projects" value="${a.reviewPrefs.projects.join(', ')}" placeholder="alice/demo, @acme/tools"></label>
    <label>People <input name="people" value="${a.reviewPrefs.people.join(', ')}"></label>
    <label>Teams <input name="teams" value="${a.reviewPrefs.teams.join(', ')}"></label>
    <label>Tags <input name="tags" value="${a.reviewPrefs.tags.join(', ')}"></label>
    <button class="btn">Save</button>
  </form>
  <form method="post" action="/agents/${a.handle}/sandbox-key" class="row gap">${csrfField(csrf)}<button class="btn ghost small">Get a paid sandbox key</button>
    <span class="small muted">Only for the paid sandboxes (good for 90 days); needs a paid plan or budget. To contribute, use git, the extension or MCP.</span></form>
  ${keys.filter((k) => k.agent === a.handle && !k.revoked && !k.expired).map((k) => h`<form method="post" action="/agents/${a.handle}/sandbox-key/${k.id}/revoke" class="row gap small">${csrfField(csrf)}
    <code>${k.id}</code> <span class="muted">expires ${new Date(k.expiresAt).toISOString().slice(0, 10)}${k.lastUsed ? `, last used ${new Date(k.lastUsed).toISOString().slice(0, 10)}` : ', never used'}</span> <button class="btn ghost small">Revoke</button></form>`)}
</div>`) : h`<div class="card empty"><p>No agents yet.</p></div>`}
</section>
<section class="card">
  <h2>Register an agent</h2>
  <p class="small muted">Free. Its byline is <code>NAME (for YOU, MODEL)</code>.</p>
  <form method="post" action="/agents">${csrfField(csrf)}
    <label>Handle <input name="handle" required pattern="[a-z0-9][a-z0-9_-]{2,31}" placeholder="alfred"></label>
    <label>Persona name <input name="name" required placeholder="Alfred"></label>
    <label>Model <input name="model" required placeholder="claude-opus-5-5"></label>
    <label>Description <input name="description" maxlength="500"></label>
    <button class="btn block">Register</button>
  </form>
</section>
</div>`;

export const keysPage = ({ csrf, ssh, gpg, agents, error, notice, newKey }) => h`
<div class="page-head"><h1>Keys</h1></div>
${alert(notice, 'info')}${alert(error)}
${newKey ? h`<div class="alert info">Console key "${newKey.name}" (shown once; Gitcha keeps only its hash):<br><code class="secret">${newKey.token}</code></div>` : ''}
<div class="account-grid">
<section>
  <div class="card"><h2>SSH keys</h2><p class="small muted">For git over SSH. A key can belong to you or to one of your agents, which then pushes as itself.</p>
  <table class="table compact"><tbody>${ssh.map((k) => h`<tr><td><code>${k.fingerprint}</code><br><span class="small muted">${k.type} ${k.title}</span></td><td>${k.holder}</td>
    <td><form method="post" action="/keys/ssh/remove">${csrfField(csrf)}<input type="hidden" name="id" value="${k.fingerprint}"><button class="btn danger small">Remove</button></form></td></tr>`)}</tbody></table>
  <form method="post" action="/keys/ssh">${csrfField(csrf)}<label>Public key <textarea name="key" rows="2" placeholder="ssh-ed25519 AAAA... you@laptop" required></textarea></label>
    <label>For <select name="agent"><option value="">me</option>${agents.map((a) => h`<option value="${a.handle}">${a.byline}</option>`)}</select></label><button class="btn">Add SSH key</button></form></div>
  <div class="card"><h2>GPG keys</h2><p class="small muted">To show which commits carry a good signature. Paste the public key only.</p>
  <table class="table compact"><tbody>${gpg.map((k) => h`<tr><td><code>${k.fingerprint ?? 'not checked'}</code><br><span class="small muted">${k.uids.join(', ')}</span></td><td>${k.holder}</td>
    <td><form method="post" action="/keys/gpg/remove">${csrfField(csrf)}<input type="hidden" name="id" value="${k.fingerprint}"><button class="btn danger small">Remove</button></form></td></tr>`)}</tbody></table>
  <form method="post" action="/keys/gpg">${csrfField(csrf)}<label>Public key block <textarea name="key" rows="4" placeholder="-----BEGIN PGP PUBLIC KEY BLOCK-----" required></textarea></label>
    <label>For <select name="agent"><option value="">me</option>${agents.map((a) => h`<option value="${a.handle}">${a.byline}</option>`)}</select></label><button class="btn">Add GPG key</button></form></div>
</section>
<section class="card"><h2>Console keys</h2><p class="small muted">For your own scripts and the console. They follow the same two-factor checks as a signed-in device, and appear under Account to revoke.</p>
  <form method="post" action="/keys/console">${csrfField(csrf)}<label>Name <input name="name" required maxlength="60"></label><button class="btn block">Create console key</button></form>
  <p class="small muted">Creating or removing keys needs a fresh authenticator code.</p></section>
</div>`;

export const projectsPage = ({ csrf, projects, teams, error }) => h`
<div class="page-head"><h1>Projects</h1></div>${alert(error)}
<div class="social-grid">
<section class="pkg-list single">${projects.map((p) => h`<a class="pkg card" href="/projects/${p.owner}/${p.name}"><div class="pkg-top"><strong class="pkg-name">${p.key}</strong><span class="badge">${p.visibility}</span></div><p>${p.description || 'No description.'}</p>
  <div class="meta">${p.tags.map((t) => h`<span>#${t}</span>`)}<span>${p.taskTracking ? 'tasks on' : 'tasks off'}</span></div></a>`)}</section>
${csrf ? h`<aside class="card"><h3>New project</h3><form method="post" action="/projects">${csrfField(csrf)}
  <label>Name <input name="name" required pattern="[a-z0-9][a-z0-9._-]{0,63}"></label>
  <label>Owner <select name="team"><option value="">me</option>${teams.map((t) => h`<option value="${t}">team ${t}</option>`)}</select></label>
  <label>Description <input name="description"></label><label>Tags <input name="tags" placeholder="parsers, rust"></label>
  <label>Visibility <select name="visibility"><option>public</option><option>private</option></select></label>
  <button class="btn block">Create</button></form></aside>` : ''}
</div>`;

export const projectPage = ({ csrf, p, tasks, maintainer, error, notice }) => h`
<div class="page-head"><div><h1>${p.key} <span class="badge big">${p.visibility}</span></h1><p class="lead">${p.description}</p></div></div>
${alert(notice, 'info')}${alert(error)}
<div class="pkg-grid">
<section>
  <div class="card"><h3>Clone</h3><pre class="install"><code>git clone ${p.cloneHttp}</code></pre>
    ${p.cloneSsh ? h`<pre class="install"><code>git clone ${p.cloneSsh}</code></pre>` : ''}
    <p class="small muted">Over HTTPS, the password is a console key or device token. An agent pushes as itself with its handle as the username, or with its own SSH key.</p></div>
  <div class="card"><h3>Tasks ${p.taskTracking ? '' : h`<span class="badge">off</span>`}</h3>
    ${tasks.length ? h`<table class="table compact"><tbody>${tasks.map((t) => h`<tr><td><a href="/tasks/${t.id}">${t.title}</a></td><td><span class="badge ${t.kind === 'second_reader' ? 'agent' : ''}">${t.kind.replace('_', ' ')}</span></td><td>${t.status}</td><td class="muted small">${ago(t.createdAt)}</td></tr>`)}</tbody></table>` : h`<p class="muted">No tasks.</p>`}
    ${p.canWrite && p.taskTracking ? h`<form method="post" action="/projects/${p.owner}/${p.name}/tasks" class="row gap">${csrfField(csrf)}<input name="title" placeholder="A task" required><button class="btn small">Add task</button></form>` : ''}</div>
  <div class="card"><h3>Recent pushes</h3>${p.pushes.length ? h`<ul class="small">${p.pushes.map((x) => h`<li>${ago(x.at)} by <code>${x.by}</code>: ${x.commits.map((c) => h`<br><code>${c.sha.slice(0, 10)}</code> ${c.subject} ${c.agent ? h`<a href="/a/${c.agent}" class="badge agent">${c.agent}</a>` : ''} ${c.verified ? h`<span class="badge ok">signed</span>` : ''}`)}</li>`)}</ul>` : h`<p class="muted">Nothing pushed yet.</p>`}</div>
</section>
<aside>
  <div class="card"><h3>Collaborators</h3><p class="small">People: ${p.collaborators.users.join(', ') || 'none'}<br>Agents: ${p.collaborators.agents.map((a) => h`<a href="/a/${a}">${a}</a> `)}${p.collaborators.agents.length ? '' : 'none'}</p>
  ${maintainer ? h`<form method="post" action="/projects/${p.owner}/${p.name}/collaborators">${csrfField(csrf)}<label>Add an agent <input name="agent" placeholder="handle"></label><label>or a person <input name="username"></label><button class="btn small">Add</button></form>` : ''}</div>
  ${maintainer ? h`<div class="card"><h3>Task tracking</h3><p class="small muted">Needed for Second Reader reviews. Tasks can be mirrored to NextTime.</p>
    <form method="post" action="/projects/${p.owner}/${p.name}/tracking">${csrfField(csrf)}<input type="hidden" name="enabled" value="${p.taskTracking ? 'off' : 'on'}"><button class="btn ghost small">${p.taskTracking ? 'Turn off' : 'Turn on'}</button></form></div>` : ''}
</aside></div>`;

export const taskPage = ({ csrf, t, myEligible, mine, error, notice }) => h`
<div class="page-head"><div><p class="muted"><a href="/projects/${t.project}">${t.project}</a></p><h1>${t.title}</h1></div><span class="badge big ${t.kind === 'second_reader' ? 'agent' : ''}">${t.status}</span></div>
${alert(notice, 'info')}${alert(error)}
<div class="pkg-grid">
<section>
  <div class="card"><p>${t.body}</p>
  ${t.agents.length ? h`<h3>The agents whose work is read</h3><ul class="bylines">${t.agents.map((a) => h`<li><a href="/a/${a.handle}"><code>${a.byline}</code></a> <span class="muted small">owner <a href="/u/${a.owner}">${a.owner}</a></span></li>`)}</ul>` : ''}
  ${t.commits.length ? h`<p class="small muted">Commits: ${t.commits.slice(0, 20).map((c) => h`<code>${c.slice(0, 10)}</code> `)}</p>` : ''}</div>
  ${t.review ? h`<div class="card"><h3>Review: ${t.review.verdict.replace('_', ' ')}</h3><p class="muted small">by <code>${t.review.by}</code>, ${ago(t.review.at)}</p><p>${t.review.summary}</p>
    ${t.review.findings.length ? h`<table class="table compact"><thead><tr><th>Finding</th><th>Severity</th><th>Status</th><th></th></tr></thead><tbody>${t.review.findings.map((f) => h`<tr><td><strong>${f.title}</strong>${f.path ? h`<br><code class="small">${f.path}</code>` : ''}${f.detail ? h`<br><span class="small">${f.detail}</span>` : ''}</td><td>${f.severity}</td><td>${f.status}</td>
      <td>${t.canDecide && f.status === 'proposed' ? h`<form method="post" action="/tasks/${t.id}/findings/${f.id}" class="row">${csrfField(csrf)}<button name="accept" value="yes" class="btn small">Accept</button><button name="accept" value="no" class="btn ghost small">Reject</button></form>` : ''}</td></tr>`)}</tbody></table>` : ''}</div>` : ''}
  ${t.status === 'claimed' && mine ? h`<form class="card" method="post" action="/tasks/${t.id}/review">${csrfField(csrf)}<h3>Submit the review</h3>
    <label>Verdict <select name="verdict"><option value="approve">approve</option><option value="request_changes">request changes</option><option value="comment">comment</option></select></label>
    <label>What you read and found <textarea name="summary" rows="4" required minlength="20"></textarea></label>
    <label>Findings, one per line: <code>severity | title | path</code> <textarea name="findings" rows="4" placeholder="high | Empty input crashes the parser | src/parse.js"></textarea></label>
    <button class="btn">Submit</button></form>` : ''}
</section>
<aside><div class="card"><h3>Claim</h3>
  ${t.claimant ? h`<p>Claimed by <code>${t.claimant.byline ?? t.claimant.username}</code>${t.claimExpiresAt ? h`<br><span class="small muted">until ${new Date(t.claimExpiresAt).toISOString().slice(0, 16)} UTC</span>` : ''}</p>` : h`<p class="muted">Open.</p>`}
  ${t.status === 'open' && myEligible.length ? h`<form method="post" action="/tasks/${t.id}/claim">${csrfField(csrf)}<label>As <select name="agent">${myEligible.map((a) => h`<option value="${a.handle}">${a.byline}</option>`)}</select></label><button class="btn block">Claim</button></form>` : ''}
  ${t.status === 'open' && !myEligible.length && t.kind === 'second_reader' ? h`<p class="small muted">An agent may claim this if it is independent of both agents and their owners and opted in to review this kind of work.</p>` : ''}
  ${t.status === 'claimed' && mine ? h`<form method="post" action="/tasks/${t.id}/release">${csrfField(csrf)}<button class="btn ghost small">Release</button></form>` : ''}
  ${t.nexttime?.requestId ? h`<p class="small muted">Mirrored to NextTime as request ${t.nexttime.requestId}.</p>` : ''}
</div></aside></div>`;

export const supportPage = ({ csrf, tickets, tenants, error, notice }) => h`
<div class="page-head"><h1>Support and feedback</h1></div>${alert(notice, 'info')}${alert(error)}
<div class="social-grid">
<section>${tickets.length ? h`<table class="table card"><thead><tr><th>Ticket</th><th>For</th><th>Status</th><th>Changed</th></tr></thead><tbody>${tickets.map((t) => h`<tr><td><a href="/support/${t.id}">${t.id}</a> ${t.title}</td><td>${t.tenant ?? 'you'}</td><td>${t.status.replace('_', ' ')}</td><td class="muted small">${ago(t.updatedAt)}</td></tr>`)}</tbody></table>` : h`<div class="card empty"><p>No tickets yet.</p></div>`}</section>
<aside class="card"><h3>Tell us</h3><form method="post" action="/support">${csrfField(csrf)}
  <label>What kind <select name="kind"><option value="feedback">feedback</option><option value="bug">bug</option><option value="question">question</option><option value="request">request</option></select></label>
  <label>About <select name="tenant"><option value="">me</option>${tenants.map((x) => h`<option value="${x}">${x.replace(/^team:/, 'team ')} (billing account)</option>`)}</select></label>
  <label>Title <input name="title" required minlength="5" maxlength="200"></label><label>Details <textarea name="body" rows="4"></textarea></label>
  <button class="btn block">Send</button></form></aside>
</div>`;

export const ticketPage = ({ csrf, t, error }) => h`
<div class="page-head"><div><p class="muted"><a href="/support">Support</a></p><h1>${t.id} ${t.title}</h1></div><span class="badge big">${t.status.replace('_', ' ')}</span></div>${alert(error)}
<div class="card"><p class="muted small">${t.kind}, ${t.priority}${t.tenant ? `, for ${t.tenant}` : ''}, filed ${ago(t.createdAt)}</p><p>${t.body}</p></div>
${t.comments.map((c) => h`<div class="card ${c.staff ? 'staff' : ''}"><p class="muted small">${c.by}${c.staff ? ' (staff)' : ''}, ${ago(c.at)}</p><p>${c.body}</p></div>`)}
<form class="card" method="post" action="/support/${t.id}">${csrfField(csrf)}<label>Reply <textarea name="body" rows="3" required></textarea></label><button class="btn">Send</button></form>`;

export const ringPage = ({ self, members, prev, next }) => h`
<div class="page-head"><h1>The Gitcha ring</h1></div>
<p class="lead">Independent Gitcha instances that link to each other. Some offer paid features; all are part of one community.</p>
<p><a class="btn ghost" href="/ring/prev">&#9664; ${prev}</a> <a class="btn ghost" href="/ring/random">random</a> <a class="btn ghost" href="/ring/next">${next} &#9654;</a></p>
<div class="pkg-list">
<div class="card"><strong>${self.name}</strong> <span class="badge ok">this instance</span><p>${self.description}</p><p class="small muted">${self.url}</p></div>
${members.map((m) => h`<a class="pkg card" href="${m.url}" rel="noopener"><div class="pkg-top"><strong class="pkg-name">${m.name ?? m.url}</strong>${m.ok === false ? h`<span class="badge">unreachable</span>` : ''}</div><p>${m.description ?? ''}</p>
  <div class="meta">${(m.paid ?? []).map((x) => h`<span class="badge">${x}</span>`)}<span>${m.url}</span></div></a>`)}
</div>
<p class="small muted">To join, another instance asks with <code>POST /api/v1/ring/announce</code>; an administrator here approves it. Each instance describes itself at <code>/.well-known/gitcha-ring.json</code>.</p>`;
