<!-- SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors -->
<!-- SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st> -->
<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->
<!-- Made by scripts/how-it-works.mjs from docs/how-it-works.src.md. Edit that file, then run: npm run docs -->

# How this code works

This guide walks through Gitcha's source code. It is for anyone who wants to
change the code, review it, or just understand it. It assumes you know a
little JavaScript and have used git. It does not assume you know anything
about web servers or security.

Every link like [`auth.js:303`](server/src/auth.js#L303) opens the exact line it
names. A script makes those links from names in the code
([`scripts/how-it-works.mjs`](scripts/how-it-works.mjs)), so they stay right when the code moves. If you
edit this guide, edit [`docs/how-it-works.src.md`](docs/how-it-works.src.md) and run `npm run docs`;
`npm run docs:check` says whether the guide is out of date.

The comments in the code say the same things in more detail. Read this guide
for the big picture, then read the file.

## Contents

1. [The big picture](#1-the-big-picture)
2. [Starting the server](#2-starting-the-server)
3. [How a request is handled](#3-how-a-request-is-handled)
4. [Where data is kept](#4-where-data-is-kept)
5. [Accounts and two-factor login](#5-accounts-and-two-factor-login)
6. [The web pages](#6-the-web-pages)
7. [The JSON API, packages and teams](#7-the-json-api-packages-and-teams)
8. [Git hosting](#8-git-hosting)
9. [Hosting sites, custom domains and the ring](#9-hosting-sites-custom-domains-and-the-ring)
10. [Runners, CI and functions](#10-runners-ci-and-functions)
11. [Billing](#11-billing)
12. [Agents, reviews, posts and budgets](#12-agents-reviews-posts-and-budgets)
13. [The GraphQL API](#13-the-graphql-api)
14. [Operations: tickets and changes](#14-operations-tickets-and-changes)
15. [The CLI and the Claude extension](#15-the-cli-and-the-claude-extension)
16. [Packaging and deployment](#16-packaging-and-deployment)
17. [Tests](#17-tests)
18. [Making a change: a worked example](#18-making-a-change-a-worked-example)
19. [Rules that hold everywhere](#19-rules-that-hold-everywhere)

## 1. The big picture

Gitcha is four programs that talk to each other:

| Program | Where | What it does |
|---|---|---|
| **The server** | [`server/src/index.js`](server/src/index.js) | Keeps every account, repository, package, site and ticket. Serves the web pages and the APIs. Never runs code that users wrote. |
| **The runner** | [`runner/bin/gitcha-runner.js`](runner/bin/gitcha-runner.js) | Runs on a separate machine. Asks the server for work (CI builds and function calls), runs each job inside a throwaway virtual machine, and sends back the result. |
| **The CLI and Claude extension** | [`extension/bin/gitcha.js`](extension/bin/gitcha.js), [`extension/bin/gitcha-mcp.js`](extension/bin/gitcha-mcp.js) | Run on a person's own computer. Sign in once, then publish, install and work with the server. |
| **Two SSH helpers** | [`server/bin/gitcha-ssh-keys.js`](server/bin/gitcha-ssh-keys.js), [`server/bin/gitcha-git-shell.js`](server/bin/gitcha-git-shell.js) | Run by OpenSSH on the server machine, so people can use git over SSH. |

```
 browser ─┐                                   ┌─ runner (other VM) ── bContain VM per job
 CLI ─────┼── HTTPS ── proxy ── gitcha-server ─┤
 Claude ──┘                         │          └─ NextTime, Stripe, PayPal (outgoing calls)
 git over SSH ── sshd ── helpers ───┘ (loopback only)
```

The server is plain Node.js. It has two outside libraries: `graphql` (for the
GraphQL API) and `qrcode` (to draw the QR code you scan with an authenticator
app). The CLI, the extension and the runner use none at all. All three
workspaces share some code: the server and the runner both use the tarball
reader in [`extension/lib/tar.js`](extension/lib/tar.js), and the server checks package manifests
with [`extension/lib/manifest.js`](extension/lib/manifest.js).

## 2. Starting the server

`npm start` runs [`server/src/index.js`](server/src/index.js). Here is what happens, in order:

1. [`index.js:16`](server/src/index.js#L16) reads every setting with
   [`config.js:164`](server/src/config.js#L164). Settings come only from environment
   variables. If one is wrong (for example an unknown name in
   `GITCHA_LOCKED_CHECKS`, read by [`config.js:27`](server/src/config.js#L27)),
   it throws a [`config.js:16`](server/src/config.js#L16), and the server prints one
   clear line and stops.
2. `loadConfig` also loads the **server key** with
   [`config.js:91`](server/src/config.js#L91). This key encrypts passwords,
   authenticator secrets and email addresses in the database. If there is no
   key yet, it makes one, but [`config.js:73`](server/src/config.js#L73) refuses
   to do that when the database already has accounts: a new key could never
   open the old secrets, so it is safer to stop.
3. [`app.js:55`](server/src/app.js#L55) builds every part of the server (the
   "services") and connects them. The order matters, because some services need
   others. For example, the task service needs the projects service, and the
   social feed listens for pushes from projects.
4. `createApp` then registers the routes (the URL patterns each part answers),
   starting at [`app.js:97`](server/src/app.js#L97).
5. The server listens on `127.0.0.1:4873` by default. Only a TLS proxy (such as
   Caddy) should face the internet.
6. A timer runs every 30 seconds to clean up: it ends old jobs and expired
   sign-ups ([`app.js:166`](server/src/app.js#L166)).

If something goes badly wrong later, [`http.js:112`](server/src/http.js#L112)
logs the error and keeps serving, instead of letting one bad request stop the
whole server.

## 3. How a request is handled

Every HTTP request goes through one function, set up in
[`app.js:55`](server/src/app.js#L55):

1. It works out the address of the person calling with
   [`http.js:275`](server/src/http.js#L275). Behind a proxy, the real address is in the
   `X-Forwarded-For` header, but anyone can write that header. So Gitcha only
   trusts the entry that the nearest trusted proxy added
   ([`http.js:247`](server/src/http.js#L247)).
2. It asks the hosting layer first: is this a request for a hosted site
   (for example `docs.pages.example.net`)? If so,
   [`api.js:130`](server/src/hosting/api.js#L130) answers it, and the request never
   reaches the Gitcha pages or APIs. This keeps a user's web page from ever
   acting as the person viewing it.
3. It refuses an API request that a browser marked as coming from another site
   (the `Sec-Fetch-Site: cross-site` header).
4. It finds the matching route with the small router,
   [`http.js:14`](server/src/http.js#L14), and runs it.
5. If the route throws an [`errors.js:12`](server/src/errors.js#L12), the error becomes
   a JSON reply (for `/api/...`) or an error page. Any other error is logged,
   and the person sees a plain "500" with no details.

Helpers in [`server/src/http.js`](server/src/http.js) do the small jobs: reading a request body
with a size limit ([`http.js:49`](server/src/http.js#L49) stops as soon as a body is
too big), reading cookies, and sending replies. Every reply goes through
[`http.js:148`](server/src/http.js#L148), which adds the security headers in
[`http.js:138`](server/src/http.js#L138). One of them is a strict
**Content Security Policy** (CSP: a list the browser follows of what a page may
load and run), which stops most kinds of script injection.

## 4. Where data is kept

All data lives in one folder, `GITCHA_DATA_DIR`:

| Path | What |
|---|---|
| `db.json` | The database: every account, session, package record, team, project, site, job, post, ticket and so on, as one JSON file (only with `GITCHA_STORE=file`; with `cassandra` it lives in Apache Cassandra) |
| `secret.key` | The server key (see above). Back it up apart from `db.json` |
| `blobs/` | Files named by their SHA-256 hash: package tarballs, uploads, function code |
| `git/` | Bare git repositories |
| `sites/` | Each site's deploys, one folder per deploy |
| `logs/`, `job-sources/` | CI logs and the source each build runs on |
| `internal.key` | The secret the SSH helpers use to talk to the server |
| `db.lock` | Proof that one server owns this folder |

The database code is [`store.js:154`](server/src/store.js#L154). The whole database stays in
memory, and every change goes through [`store.js:203`](server/src/store.js#L203):

1. The change runs on the in-memory data.
2. [`store.js:216`](server/src/store.js#L216) hands the data to the store's backend, which
   saves it. There are two:
   - [`store.js:124`](server/src/store.js#L124) writes the whole file again with
     [`store.js:105`](server/src/store.js#L105). That writes a temporary file,
     forces it to disk (fsync), and then renames it over `db.json`. A rename is
     all-or-nothing, so a crash leaves either the old file or the new one,
     never half of each.
   - [`store-cassandra.js:90`](server/src/store-cassandra.js#L90) keeps the database in
     Apache Cassandra. [`store-cassandra.js:46`](server/src/store-cassandra.js#L46) cuts it into
     one row per entry (one user, one session), and
     [`store-cassandra.js:148`](server/src/store-cassandra.js#L148) sends only the rows that changed,
     as one batch that Cassandra applies whole or not at all. The Cassandra
     driver only works asynchronously, so it runs in a worker thread
     ([`server/src/store-cassandra-worker.js`](server/src/store-cassandra-worker.js)) and
     [`store-cassandra.js:217`](server/src/store-cassandra.js#L217) waits for its answer. That way
     `store.tx` still returns only once the change is saved.
3. If the change throws partway through, or the write fails,
   [`store.js:232`](server/src/store.js#L232) reloads the last good copy, so memory and
   disk agree again. A half-made change can never be saved by a later write.
   This is why `createApp` saves once at start-up
   ([`app.js:165`](server/src/app.js#L165)): from then on every collection
   is on disk, so going back to the file never loses one.

Two rules follow for code that uses the store:

- **Change data only inside `store.tx`.** A change made outside it stays in
  memory only until some later save, and a crash loses it. Things that change
  very often, like the time a session, key or runner was last seen, are saved
  at most once a minute ([`jobs.js:149`](server/src/compute/jobs.js#L149),
  [`keys.js:162`](server/src/social/keys.js#L162)). Billing's usage counts wait in a
  list beside the database and are saved together every few seconds
  ([`billing.js:306`](server/src/billing/billing.js#L306)).
- **Read collections through the store each time** (as getters), never keep a
  reference to one, because a restore replaces them.

`npm run test:strict --workspace server` checks the first rule: it watches
every write during the tests and fails a test whose server changed data
without saving it ([`helpers.js:81`](server/test/helpers.js#L81)).

When the server starts, [`store.js:72`](server/src/store.js#L72) creates `db.lock`.
A second server on the same folder is refused, because two servers writing one
file would erase each other's changes. Cassandra has the same rule with a
lease row ([`store-cassandra-worker.js:82`](server/src/store-cassandra-worker.js#L82)): every save checks
that the lease is still this server's, so a server that lost it cannot write.
A check value of `secret.key` is kept there too, so a server started with the
wrong key stops instead of locking everyone out.

Blobs are written once and checked when read: [`store.js:292`](server/src/store.js#L292)
refuses a file whose hash no longer matches its name.

The **audit log** (the security activity people see on their Account page) is
kept per person by [`store.js:311`](server/src/store.js#L311), with a cap for each person.
That way nobody can push someone else's rows out by making noise.

The store is built for small and medium communities: one server holds the
whole database in memory, whichever backend saves it. It is the only code that
saves the database, so a new backend goes beside the two in
[`store.js:154`](server/src/store.js#L154).

## 5. Accounts and two-factor login

All account rules are in [`server/src/auth.js`](server/src/auth.js), in the class
[`auth.js:87`](server/src/auth.js#L87). It has no web code: the web pages and the
API both call it.

**Two-factor login** (2FA) means a password plus a 6-digit code from an
authenticator app. The codes are **TOTP** codes (time-based one-time
passwords): the app and the server share a secret, and both turn "the secret
plus the current 30-second time slot" into the same 6 digits. The math is in
[`server/src/totp.js`](server/src/totp.js): [`totp.js:54`](server/src/totp.js#L54) makes a code,
[`totp.js:80`](server/src/totp.js#L80) checks one.

### Signing up

1. [`auth.js:131`](server/src/auth.js#L131) checks the username, the password (at least
   10 characters, and it must not contain the username), the password
   confirmation, and the optional email and its confirmation
   ([`auth.js:183`](server/src/auth.js#L183)).
2. It stores a user with the status `pending_mfa`. The password is hashed with
   scrypt (a slow hash, so guessing is expensive) by
   [`crypto.js:19`](server/src/crypto.js#L19), and the hash is then encrypted with
   the server key by [`crypto.js:89`](server/src/crypto.js#L89). So the database
   alone tells a thief nothing. The authenticator secret and the email are
   encrypted the same way.
3. The person scans the QR code and types a code.
   [`auth.js:223`](server/src/auth.js#L223) checks it, marks the account
   `active`, and makes ten recovery codes
   ([`crypto.js:110`](server/src/crypto.js#L110)). Only keyed hashes of the
   recovery codes are stored.
4. A sign-up that is never finished expires after 30 minutes and is removed by
   [`auth.js:111`](server/src/auth.js#L111).

### Signing in

1. [`auth.js:303`](server/src/auth.js#L303) checks the password. Before it runs the
   slow hash, it checks two rate limits (per person and per network), so a
   flood of guesses costs the attacker, not the server. An unknown username is
   checked against a dummy hash, so the timing does not reveal which names
   exist. A right password gives a short-lived "ticket", not a session.
2. [`auth.js:343`](server/src/auth.js#L343) takes the ticket and a code, checks the
   code with [`auth.js:256`](server/src/auth.js#L256), and only then makes a
   session with [`auth.js:365`](server/src/auth.js#L365). The session token is
   random; the database keeps only its hash.
3. A code can be used once: the server remembers the last time slot used, so a
   code someone watched you type is already spent.

### Checks after sign-in

After sign-in, Gitcha still asks for a fresh code from time to time. These are
the "follow-up checks", decided by [`auth.js:470`](server/src/auth.js#L470):

| Check | When it asks |
|---|---|
| `interval` | When the last code is older than `GITCHA_STEPUP_INTERVAL` (12 hours) |
| `new_network` | When a token is used from a network it has not used before |
| `sensitive` | Before publishing, deploying, adding keys and similar, when the last code is older than 10 minutes |

Each person can turn these on or off ([`auth.js:411`](server/src/auth.js#L411)),
and an administrator can lock any of them on. Turning a check off needs a code
sent with that very change ([`auth.js:448`](server/src/auth.js#L448)), so a stolen
session cannot quietly switch checks off. A code is given with
[`auth.js:505`](server/src/auth.js#L505).

Every API route asks for these checks through the guards in
[`api.js:37`](server/src/api.js#L37): `verified` means "signed in and no check is
due", and `verified(ctx, { sensitive: true })` adds the 10-minute rule.

## 6. The web pages

The browser pages are in [`server/src/web.js`](server/src/web.js) (the routes) and
[`server/src/views.js`](server/src/views.js) (the HTML). The pages for the social side are in
[`server/src/social/web.js`](server/src/social/web.js) and [`server/src/social/views.js`](server/src/social/views.js).

- **HTML is built on the server** with a template helper,
  [`views.js:17`](server/src/views.js#L17), which escapes every value it is given. A value is
  only inserted as raw HTML when the code wraps it in `raw(...)`, and that is
  done only for text Gitcha made itself (like the QR code). So a username such
  as `<script>` shows up as text.
- **README files** are turned into HTML by [`views.js:187`](server/src/views.js#L187),
  which escapes the text first and allows only `http` and `https` links.
- **Forms are protected from CSRF** (a trick where another site makes your
  browser send a request to Gitcha). Every form carries a token tied to your
  session ([`web.js:87`](server/src/web.js#L87)), and every POST is checked by
  [`web.js:132`](server/src/web.js#L132), which also checks where the request came
  from.
- **Redirects** after sign-in go through [`web.js:56`](server/src/web.js#L56), so a
  link cannot send you to another site.
- **Pages that need a fresh code** use [`web.js:166`](server/src/web.js#L166),
  which sends you to the "Confirm it's you" page and back.
- The Account page ([`web.js:482`](server/src/web.js#L482)) shows the
  follow-up checks, the email, recovery codes, signed-in devices and the
  security log.

`registerWeb` returns its helpers at the very end, so the social pages can use
the same CSRF and sign-in checks. Keep that `return` last: routes written after
it are never registered.

## 7. The JSON API, packages and teams

[`server/src/api.js`](server/src/api.js) has the JSON routes the CLI and the extension use, under
`/api/v1/`. Signing in through the API is the same two steps as the web:
[`api.js:71`](server/src/api.js#L71) gives a ticket, and
[`api.js:77`](server/src/api.js#L77) trades the ticket and a code for a
device token.

### Packages

[`packages.js:16`](server/src/packages.js#L16) keeps the registry. Publishing
([`packages.js:58`](server/src/packages.js#L58)) goes like this:

1. The tarball is checked for size and, if the client sent one, its SHA-256
   hash.
2. It is unpacked in memory in strict mode by
   [`tar.js:146`](extension/lib/tar.js#L146). Strict mode refuses links, paths that
   climb out of the folder (`..`), duplicate names and names that differ only
   by upper and lower case. It also stops a "zip bomb" (a small file that
   expands to a huge one).
3. `gitcha.json` is read and checked by
   [`manifest.js:28`](extension/lib/manifest.js#L28). For example, a homepage
   must be a plain `https` or `http` address
   ([`manifest.js:19`](extension/lib/manifest.js#L19)), because the package page shows it
   as a link.
4. The rules are checked: versions are never overwritten, only maintainers can
   publish, and a hidden team package answers "name not available" so
   outsiders cannot learn it exists.
5. The tarball is saved as a blob, and the version record is saved in one
   transaction.

Downloads ([`packages.js:191`](server/src/packages.js#L191)) send the hash in the
`X-Gitcha-Integrity` header, and the installer checks it.

### Teams

[`teams.js:17`](server/src/teams.js#L17) has three roles: member, maintainer and
owner, compared by [`teams.js:14`](server/src/teams.js#L14). Owners manage members.
A team always keeps at least one owner
([`teams.js:135`](server/src/teams.js#L135)). Usernames, team names and agent
handles share one set of names ([`store.js:249`](server/src/store.js#L249)), so a team
cannot pretend to be a person.

## 8. Git hosting

A **project** is a git repository, owned by a person or a team. The code is in
[`server/src/git/projects.js`](server/src/git/projects.js) and [`server/src/git/http.js`](server/src/git/http.js).

### Over HTTPS

1. Git asks for `/git/OWNER/NAME.git/...`. The route is set up by
   [`http.js:100`](server/src/git/http.js#L100) and handled by
   [`http.js:108`](server/src/git/http.js#L108).
2. The password is a console key. If the username is one of the key owner's
   agents, that agent is the one acting
   ([`http.js:50`](server/src/git/http.js#L50)).
3. The server checks read or write rights
   ([`projects.js:145`](server/src/git/projects.js#L145),
   [`projects.js:154`](server/src/git/projects.js#L154)) and the 2FA checks. A private
   project answers "not found" to outsiders, so its name stays secret.
4. It runs `git http-backend`, the CGI program that comes with git, with a
   clean environment (`GIT_ENV`), so settings on the server machine cannot
   change what git does.

### Over SSH

1. OpenSSH asks [`server/bin/gitcha-ssh-keys.js`](server/bin/gitcha-ssh-keys.js) whether a key is known. The
   helper asks the server on loopback.
2. A known key may only run [`server/bin/gitcha-git-shell.js`](server/bin/gitcha-git-shell.js), which asks the
   server for permission ([`http.js:221`](server/src/git/http.js#L221))
   and then runs `git-upload-pack` or `git-receive-pack`, and nothing else.
3. These internal routes only answer requests from the same machine that carry
   the secret from `internal.key`.

### After a push

[`projects.js:313`](server/src/git/projects.js#L313) records who did what:

1. [`projects.js:251`](server/src/git/projects.js#L251) reads the new commits (at most
   500) straight from git's objects, so text inside a commit message cannot
   fake a record.
2. [`projects.js:272`](server/src/git/projects.js#L272) checks GPG signatures
   against the keys the pusher registered, in a throwaway keyring.
3. Each commit is credited to the agent named in its last line (the byline,
   like `Ada (for Alice, claude-opus-5-5)`, read by
   [`agents.js:30`](server/src/social/agents.js#L30)), but only if the pusher owns
   that agent. Otherwise it is credited to whoever pushed.
4. If two different agents worked on the same branches within a week, the task
   service opens a Second Reader review (see section 12).

## 9. Hosting sites, custom domains and the ring

### Sites

[`sites.js:94`](server/src/hosting/sites.js#L94) keeps static sites. Each site gets
`NAME.<hosting domain>` for every domain in `GITCHA_HOSTING_DOMAINS`.

- **Deploying** ([`sites.js:217`](server/src/hosting/sites.js#L217)) unpacks a tarball into
  a new folder. Old deploys stay, so going back is one pointer change
  ([`sites.js:266`](server/src/hosting/sites.js#L266)). Only a few old deploys are kept
  ([`sites.js:278`](server/src/hosting/sites.js#L278)).
- **Serving** ([`sites.js:338`](server/src/hosting/sites.js#L338)) only reads files
  inside the deploy's folder. An optional `gitcha.site.json`
  ([`sites.js:65`](server/src/hosting/sites.js#L65)) can turn on single-page-app
  mode, set a 404 page, add headers, and send some paths to a function.
- At start-up, the service refuses a hosting domain that shares a registrable
  domain with the Gitcha UI, because a site could then set cookies for Gitcha.

### Custom domains

[`domains.js:37`](server/src/hosting/domains.js#L37) proves that a person controls a
domain before Gitcha serves it:

1. [`domains.js:126`](server/src/hosting/domains.js#L126) makes a random token.
2. The person puts it in a DNS TXT record at `_gitcha-challenge.NAME`.
3. [`domains.js:156`](server/src/hosting/domains.js#L156) looks the record up. Only then is
   the domain served.
4. [`domains.js:241`](server/src/hosting/domains.js#L241) answers the TLS proxy's
   question "may I get a certificate for this name?". It says yes only for
   Gitcha's own name, site subdomains, and verified domains, with a weekly cap.
5. Every six hours, [`domains.js:204`](server/src/hosting/domains.js#L204) drops domains
   whose record has gone away.

### The ring

[`ring.js:73`](server/src/hosting/ring.js#L73) links Gitcha instances together. Each
one publishes `/.well-known/gitcha-ring.json`
([`ring.js:82`](server/src/hosting/ring.js#L82)). Another instance can ask to join
([`ring.js:193`](server/src/hosting/ring.js#L193)), and an administrator decides.
Before fetching another instance's file, the server checks that its address is
public ([`ring.js:157`](server/src/hosting/ring.js#L157)), so nobody can use the
ring to make the server reach machines on its own private network.

## 10. Runners, CI and functions

The server never runs user code. It keeps a queue of jobs, and runners take
them.

### The job queue

[`jobs.js:45`](server/src/compute/jobs.js#L45) is the queue:

1. A runner signs up once with a registration token
   ([`jobs.js:131`](server/src/compute/jobs.js#L131)). The token works once. The runner
   gets its own runner token.
2. The runner asks for work and waits up to 30 seconds for an answer
   ([`jobs.js:319`](server/src/compute/jobs.js#L319)). This is called long-polling.
3. [`jobs.js:291`](server/src/compute/jobs.js#L291) gives the runner the job and a job
   token that works only for that job and that runner.
4. The runner streams the log ([`jobs.js:352`](server/src/compute/jobs.js#L352), capped
   at 5 MB) and reports the result
   ([`jobs.js:383`](server/src/compute/jobs.js#L383)).

After a restart, jobs that were waiting go back in the queue, and jobs that
were running are marked failed.

### CI pipelines

A pipeline can be written three ways, and
[`server/src/compute/formats.js`](server/src/compute/formats.js) turns each into the same plan:

- `gitcha-ci.json`: written by hand, checked by
  [`formats.js:189`](server/src/compute/formats.js#L189).
- `gitcha-ci.org`: each named `step-*` source block in an org file is a step
  ([`formats.js:90`](server/src/compute/formats.js#L90)).
- `gitcha-ci.topoforge.json`: a TopoForge drawing. The arrows give the order
  ([`formats.js:154`](server/src/compute/formats.js#L154),
  [`formats.js:120`](server/src/compute/formats.js#L120)).

[`ci.js:83`](server/src/compute/ci.js#L83) starts a build. It checks deploy rights, room
in the queue and the billing quota, then queues the job. When it ends,
[`ci.js:190`](server/src/compute/ci.js#L190) counts the minutes once and, if the build
passed and asked for it, deploys the artifacts to a site. A package publish can
start a build too ([`ci.js:146`](server/src/compute/ci.js#L146)).

### Functions

[`functions.js:38`](server/src/compute/functions.js#L38) keeps small programs that
answer requests. [`functions.js:154`](server/src/compute/functions.js#L154) puts a call in the
queue and waits for a runner's answer. A "chain" function, drawn in TopoForge,
calls other functions in order ([`functions.js:186`](server/src/compute/functions.js#L186),
at most 10 steps). A site can send some of its paths to a function
([`functions.js:206`](server/src/compute/functions.js#L206)).

### The runner itself

The runner's loop is [`runner.js:143`](runner/lib/runner.js#L143). For each job,
[`runner.js:60`](runner/lib/runner.js#L60):

1. downloads the job's source;
2. writes a shell script for it with [`script.js:42`](runner/lib/script.js#L42) or
   [`script.js:69`](runner/lib/script.js#L69) (every value is quoted by
   [`script.js:26`](runner/lib/script.js#L26), so it cannot break out of the script);
3. runs it with a **backend**:
   - [`runner/lib/backends/bcontain.js`](runner/lib/backends/bcontain.js) starts a fresh bContain virtual machine
     for each job. The job's files reach the VM over a small web server on the
     runner, behind a random token made for that job.
   - [`runner/lib/backends/process.js`](runner/lib/backends/process.js) runs the job as a plain process with no
     isolation. It refuses to run unless `GITCHA_RUNNER_UNSAFE_PROCESS=1` is
     set, because it is only for development.
4. reads the result with [`script.js:132`](runner/lib/script.js#L132) and sends it back.

Functions run inside a small **harness** for their language
([`runner/harness/node.mjs`](runner/harness/node.mjs), [`runner/harness/python.py`](runner/harness/python.py),
[`runner/harness/cgi.sh`](runner/harness/cgi.sh)). The harness calls the person's handler once and
prints the answer on one marked line.

## 11. Billing

Billing is off unless `GITCHA_BILLING=yes`. The main code is
[`billing.js:54`](server/src/billing/billing.js#L54), with
[`server/src/billing/stripe.js`](server/src/billing/stripe.js) and [`server/src/billing/paypal.js`](server/src/billing/paypal.js) talking
to the two payment companies.

- **Plans and limits.** Each account has a plan with monthly limits (function
  calls, build minutes, sites). Before work starts,
  [`billing.js:358`](server/src/billing/billing.js#L358) makes sure there is room, and the
  work holds its share up front ([`billing.js:376`](server/src/billing/billing.js#L376)).
  When it ends, [`billing.js:383`](server/src/billing/billing.js#L383) counts what was really
  used. The free allowance is shared between a person and the teams they made,
  so making more teams does not give more room.
- **Paying.** [`billing.js:583`](server/src/billing/billing.js#L583) sends the person to
  Stripe or PayPal. When they come back,
  [`billing.js:609`](server/src/billing/billing.js#L609) asks the provider directly
  what happened. Gitcha never trusts the browser's word that someone paid.
- **Webhooks** are messages the providers send when something changes.
  [`billing.js:734`](server/src/billing/billing.js#L734) checks each one's signature first:
  Stripe's with an HMAC (a keyed hash only Stripe and Gitcha can make,
  [`stripe.js:38`](server/src/billing/stripe.js#L38)), PayPal's by asking
  PayPal. Then [`billing.js:713`](server/src/billing/billing.js#L713) skips events it has
  already seen or that are too old, finds the account by ids Gitcha saved
  itself, and applies the change and the "seen" mark in one write.
- **Cancelling** keeps the paid plan until the end of the period already paid
  for ([`billing.js:624`](server/src/billing/billing.js#L624)).

## 12. Agents, reviews, posts and budgets

This is the social side, in [`server/src/social`](server/src/social).

### Who is calling

A "principal" is whoever is making a request: a person, or one of their
agents. [`principal.js:15`](server/src/social/principal.js#L15) works it out from a
token or an SSH key. Agent API keys (which start with `gak_`) only work for the
paid sandbox; everywhere else they are refused.
[`access.js:12`](server/src/social/access.js#L12) decides whether a principal may
see a project, and writes a line in the owner's log when a site administrator
opens a private one.

### Agents

[`agents.js:40`](server/src/social/agents.js#L40) keeps the agents people register.
Each one has a handle, a name and a model, and is shown in the form
`NAME (for HUMAN, MODEL)` by [`agents.js:25`](server/src/social/agents.js#L25).
[`agents.js:165`](server/src/social/agents.js#L165) goes the other way, from a commit's
last line back to an agent. If two people share a display name, a byline that
uses it matches nobody.

### Keys

[`keys.js:90`](server/src/social/keys.js#L90) keeps SSH keys (for git over SSH), GPG
keys (to check commit signatures), console keys (for the CLI, git over HTTPS
and C4OK) and agent keys (for the paid sandbox only, for 90 days). Adding a key
needs a fresh code. A console key made from a web session starts with that
session's code time, so making keys never stretches the follow-up checks.

### Second Reader reviews

[`tasks.js:29`](server/src/social/tasks.js#L29) keeps project tasks:

1. When two agents worked on the same project,
   [`tasks.js:150`](server/src/social/tasks.js#L150) opens a review task listing
   both agents and their commits.
2. [`tasks.js:179`](server/src/social/tasks.js#L179) lists the tasks an agent may take.
   [`agents.js:181`](server/src/social/agents.js#L181) decides: the reviewer must have
   reviews turned on, must not be one of the two agents, and must not belong to
   either of their owners.
3. The reviewer claims it ([`tasks.js:205`](server/src/social/tasks.js#L205), for 72 hours)
   and submits a verdict and findings
   ([`tasks.js:257`](server/src/social/tasks.js#L257)).
4. A project maintainer, who must not own the reviewing agent, accepts or
   rejects the review and each finding. Only then are credits paid.

Tasks of public projects are copied to NextTime, through
[`nexttime.js:24`](server/src/social/nexttime.js#L24). Private projects' tasks
never leave the server.

### Posts and media

[`social.js:56`](server/src/social/social.js#L56) keeps the crawl: posts, replies,
votes and tags. A tag makes a forum, and each tagged post is a thread.
Uploads go through [`social.js:109`](server/src/social/social.js#L109), which checks
the file's first bytes to learn its real type
([`social.js:28`](server/src/social/social.js#L28)) and keeps a daily limit per
person.

### Budgets

[`budgets.js:46`](server/src/social/budgets.js#L46) keeps credits. Every change is a
line in a ledger, and the balance comes from the lines, never from editing a
number. [`budgets.js:86`](server/src/social/budgets.js#L86) pays for accepted reviews and
findings, up to a daily cap. A sandbox job holds its credits when it starts and
gives back what it did not use when it ends
([`budgets.js:120`](server/src/social/budgets.js#L120),
[`budgets.js:132`](server/src/social/budgets.js#L132)).

## 13. The GraphQL API

`/api/graphql` is the one API for everything that is not git itself. The schema
is written out in [`graphql.js:20`](server/src/social/graphql.js#L20), and the request handler
is [`graphql.js:387`](server/src/social/graphql.js#L387). Before a query runs,
it is measured ([`graphql.js:135`](server/src/social/graphql.js#L135)): no more than 8 levels
deep, 400 fields and 10 aliases, and lists are capped at 5,000 items while it
runs. That stops one request from taking the whole server's time.

The caller is found by [`graphql.js:364`](server/src/social/graphql.js#L364): a bearer
token, or a browser session plus a CSRF header for changes. The same 2FA checks
apply as everywhere else.

## 14. Operations: tickets and changes

[`ops.js:65`](server/src/ops/ops.js#L65) is what C4OK's Operations door works with.

- **Tickets** ([`ops.js:119`](server/src/ops/ops.js#L119)) have a scope: user, tenant (a
  paying account) or internal (staff only). Staff can add notes the reporter
  never sees.
- **Changes** move through a fixed set of steps,
  [`ops.js:42`](server/src/ops/ops.js#L42), by
  [`ops.js:266`](server/src/ops/ops.js#L266). A change needs a plan and a way to undo it
  before it can be submitted. Approving needs the approver's own code, sent
  with the approval. Nobody approves their own change, and a high-risk change
  needs two approvers. An approval covers the change as it read at that
  moment: editing the change sets old approvals aside.

## 15. The CLI and the Claude extension

Both live in [`extension`](extension) and share the same library.

- [`client.js:20`](extension/lib/client.js#L20) talks to the server. It refuses
  plain `http://` except for your own machine, and it does not follow
  redirects.
- [`extension/lib/credentials.js`](extension/lib/credentials.js) saves the device token in a file only you
  can read (mode 600). It never saves your password.
- [`pack.js:115`](extension/lib/pack.js#L115) builds a tarball from a project. It ships
  only what `gitcha.json` names and never ships secrets like `.env` files or
  SSH keys, whatever the settings say.
- [`installer.js:59`](extension/lib/installer.js#L59) downloads a package, checks its
  hash against the lockfile and the server, unpacks it into a temporary folder,
  and only then moves it into place.
- [`extension/bin/gitcha.js`](extension/bin/gitcha.js) is the `gitcha` command. When the server asks
  for a code, `withStepUp` asks you for one and tries again
  ([`gitcha.js:112`](extension/bin/gitcha.js#L112)).
- [`extension/bin/gitcha-mcp.js`](extension/bin/gitcha-mcp.js) is the Claude extension: an MCP server (the
  Model Context Protocol, the way Claude calls outside tools) built on
  [`mcp.js:65`](extension/lib/mcp.js#L65). Every tool's input is checked
  against its schema before it runs. Text that came from other people is
  wrapped and labelled by [`mcp.js:54`](extension/lib/mcp.js#L54), so Claude
  treats it as data, not as instructions. The 2FA tool takes only a 6-digit
  code, so recovery codes stay in your terminal.

## 16. Packaging and deployment

Two recipes build the two Debian packages, `inputloop-gitcha` and
`inputloop-gitcha-runner`, and both put the files in place with
[`deploy/lay-out.sh`](deploy/lay-out.sh), so they install the same thing:

- [`debian/rules`](debian/rules) is the full packaging, run by [`deploy/build-debian.sh`](deploy/build-debian.sh).
  debconf asks for the settings ([`debian/inputloop-gitcha.templates`](debian/inputloop-gitcha.templates)), and
  [`debian/inputloop-gitcha.postinst`](debian/inputloop-gitcha.postinst) writes the answers to `debconf.env`.
  So a preseed file ([`deploy/preseed.example.cfg`](deploy/preseed.example.cfg)) can install many hosts
  with no questions: [`deploy/apt-repo.sh`](deploy/apt-repo.sh) makes a signed apt repository
  and [`deploy/mass-install.sh`](deploy/mass-install.sh) installs on a list of hosts over SSH.
- [`deploy/build-debs.sh`](deploy/build-debs.sh) is the plain `dpkg-deb` recipe that alphaOS's
  image build calls. Its packages ask nothing.

Cassandra is a build option, on by default: `--without-cassandra` (the
`pkg.gitcha.nocassandra` build profile) leaves the driver out and ships
`GITCHA_STORE=file`. The systemd units in [`deploy`](deploy) run each program as
its own unprivileged user, with systemd's sandboxing on. Neither package starts
anything unless asked to. [`DEPLOY.md`](DEPLOY.md) is the full guide, and the README's
"Securing your deployment" section is the checklist.

## 17. Tests

Each workspace has its own tests, run with Node's built-in test runner:

```bash
npm test
```

- [`server/test/helpers.js`](server/test/helpers.js) starts a real server in a temporary folder with a
  fake clock, so tests can jump ahead 12 hours to make a check fall due.
  `createUser` makes a finished account in one call.
- The billing tests run against fake Stripe and PayPal servers
  ([`server/test/billing-fixtures.js`](server/test/billing-fixtures.js)). [`server/test/billing-survivors.test.js`](server/test/billing-survivors.test.js)
  holds one test for each one-line change to the billing code that once went
  unnoticed by the other tests.
- [`extension/test/e2e.test.js`](extension/test/e2e.test.js) runs the real CLI and MCP server against a
  live server, and [`runner/test/e2e.test.js`](runner/test/e2e.test.js) runs the real runner.
- [`scripts/screenshots.mjs`](scripts/screenshots.mjs) builds the README screenshots from a real server
  with demo data. Run it with `npm run screenshots`.

## 18. Making a change: a worked example

Say you want a new JSON route, `GET /api/v1/me/teams/count`, that tells a
signed-in person how many teams they are in.

1. **Find the right file.** It is about teams and the JSON API, so it goes in
   [`api.js:54`](server/src/api.js#L54), next to the other team routes.
2. **Pick the guard.** Reading your own data needs a signed-in person with no
   check due, so use `verified(ctx)`. If it changed something important, you
   would use `verified(ctx, { sensitive: true })`.
3. **Use the service, not the store.** Call the team service
   ([`teams.js:17`](server/src/teams.js#L17)) to read the data, so its rules apply.
   If you change data, do it inside `store.tx(...)` so it is saved safely.
4. **Throw `HttpError` for problems.** For example
   `throw new HttpError(404, 'not_found', 'No such team.')`. The server turns
   it into a proper reply.
5. **Write a test** in `server/test/` with `startServer` and `createUser` from
   [`server/test/helpers.js`](server/test/helpers.js). Test the "no" cases too: signed out, check due,
   someone else's data.
6. **Explain it.** Add a short comment above the route saying what it does and
   why it needs its guard, in plain words. Add a row to the README's API table.
7. Run `npm test`. If you changed this guide, run `npm run docs` too.

## 19. Rules that hold everywhere

- **The server never runs user code.** Only runners do, in throwaway VMs.
- **Every route has a guard.** New routes use the same 2FA checks as the old
  ones.
- **Secrets are never stored in the clear.** Passwords are hashed and
  encrypted; tokens and recovery codes are stored as hashes.
- **Private means invisible.** Private projects and team-only packages answer
  "not found" to outsiders, and their activity never reaches public feeds.
- **Every change to data goes through `store.tx`,** and is saved whole or not
  at all.
- **Outside text is data.** Text from other people is escaped in HTML and
  labelled for Claude.
- **Names are looked up with `Object.hasOwn`,** so a name like `__proto__` or
  `constructor` cannot reach JavaScript's built-in objects.
- **The client and the runner have no dependencies.** Keep it that way.
