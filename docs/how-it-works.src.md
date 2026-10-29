<!-- SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors -->
<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->
<!-- The source of HOW-IT-WORKS.md. References like [[file#name]] become links with line numbers: run npm run docs. -->

# How this code works

This guide walks through Gitcha's source code. It is for anyone who wants to
change the code, review it, or just understand it. It assumes you know a
little JavaScript and have used git. It does not assume you know anything
about web servers or security.

Every link like [[server/src/auth.js#beginLogin]] opens the exact line it
names. A script makes those links from names in the code
([[scripts/how-it-works.mjs]]), so they stay right when the code moves. If you
edit this guide, edit [[docs/how-it-works.src.md]] and run `npm run docs`;
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
| **The server** | [[server/src/index.js]] | Keeps every account, repository, package, site and ticket. Serves the web pages and the APIs. Never runs code that users wrote. |
| **The runner** | [[runner/bin/gitcha-runner.js]] | Runs on a separate machine. Asks the server for work (CI builds and function calls), runs each job inside a throwaway virtual machine, and sends back the result. |
| **The CLI and Claude extension** | [[extension/bin/gitcha.js]], [[extension/bin/gitcha-mcp.js]] | Run on a person's own computer. Sign in once, then publish, install and work with the server. |
| **Two SSH helpers** | [[server/bin/gitcha-ssh-keys.js]], [[server/bin/gitcha-git-shell.js]] | Run by OpenSSH on the server machine, so people can use git over SSH. |

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
reader in [[extension/lib/tar.js]], and the server checks package manifests
with [[extension/lib/manifest.js]].

## 2. Starting the server

`npm start` runs [[server/src/index.js]]. Here is what happens, in order:

1. [[server/src/index.js#startOrExplain]] reads every setting with
   [[server/src/config.js#loadConfig]]. Settings come only from environment
   variables. If one is wrong (for example an unknown name in
   `GITCHA_LOCKED_CHECKS`, read by [[server/src/config.js#parseLockedChecks]]),
   it throws a [[server/src/config.js#StartupError]], and the server prints one
   clear line and stops.
2. `loadConfig` also loads the **server key** with
   [[server/src/config.js#loadSecretKey]]. This key encrypts passwords,
   authenticator secrets and email addresses in the database. If there is no
   key yet, it makes one, but [[server/src/config.js#refuseIfAccounts]] refuses
   to do that when the database already has accounts: a new key could never
   open the old secrets, so it is safer to stop.
3. [[server/src/app.js#createApp]] builds every part of the server (the
   "services") and connects them. The order matters, because some services need
   others. For example, the task service needs the projects service, and the
   social feed listens for pushes from projects.
4. `createApp` then registers the routes (the URL patterns each part answers),
   starting at [[server/src/app.js#"registerApi(router"]].
5. The server listens on `127.0.0.1:4873` by default. Only a TLS proxy (such as
   Caddy) should face the internet.
6. A timer runs every 30 seconds to clean up: it ends old jobs and expired
   sign-ups ([[server/src/app.js#"setInterval"]]).

If something goes badly wrong later, [[server/src/http.js#installLastResort]]
logs the error and keeps serving, instead of letting one bad request stop the
whole server.

## 3. How a request is handled

Every HTTP request goes through one function, set up in
[[server/src/app.js#createApp]]:

1. It works out the address of the person calling with
   [[server/src/http.js#clientIp]]. Behind a proxy, the real address is in the
   `X-Forwarded-For` header, but anyone can write that header. So Gitcha only
   trusts the entry that the nearest trusted proxy added
   ([[server/src/http.js#parseTrustedProxies]]).
2. It asks the hosting layer first: is this a request for a hosted site
   (for example `docs.pages.example.net`)? If so,
   [[server/src/hosting/api.js#serveHosted]] answers it, and the request never
   reaches the Gitcha pages or APIs. This keeps a user's web page from ever
   acting as the person viewing it.
3. It refuses an API request that a browser marked as coming from another site
   (the `Sec-Fetch-Site: cross-site` header).
4. It finds the matching route with the small router,
   [[server/src/http.js#Router]], and runs it.
5. If the route throws an [[server/src/errors.js#HttpError]], the error becomes
   a JSON reply (for `/api/...`) or an error page. Any other error is logged,
   and the person sees a plain "500" with no details.

Helpers in [[server/src/http.js]] do the small jobs: reading a request body
with a size limit ([[server/src/http.js#readBody]] stops as soon as a body is
too big), reading cookies, and sending replies. Every reply goes through
[[server/src/http.js#send]], which adds the security headers in
[[server/src/http.js#SECURITY_HEADERS]]. One of them is a strict
**Content Security Policy** (CSP: a list the browser follows of what a page may
load and run), which stops most kinds of script injection.

## 4. Where data is kept

All data lives in one folder, `GITCHA_DATA_DIR`:

| Path | What |
|---|---|
| `db.json` | The database: every account, session, package record, team, project, site, job, post, ticket and so on, as one JSON file |
| `secret.key` | The server key (see above). Back it up apart from `db.json` |
| `blobs/` | Files named by their SHA-256 hash: package tarballs, uploads, function code |
| `git/` | Bare git repositories |
| `sites/` | Each site's deploys, one folder per deploy |
| `logs/`, `job-sources/` | CI logs and the source each build runs on |
| `internal.key` | The secret the SSH helpers use to talk to the server |
| `db.lock` | Proof that one server owns this folder |

The database code is [[server/src/store.js#Store]]. The whole database stays in
memory, and every change goes through [[server/src/store.js#tx]]:

1. The change runs on the in-memory data.
2. [[server/src/store.js#flush]] writes the whole file again with
   [[server/src/store.js#writeFileDurably]]. That writes a temporary file, forces
   it to disk (fsync), and then renames it over `db.json`. A rename is
   all-or-nothing, so a crash leaves either the old file or the new one, never
   half of each.
3. If the write fails, [[server/src/store.js#restore]] reloads the last good
   copy, so memory and disk agree again.

When the server starts, [[server/src/store.js#acquireLock]] creates `db.lock`.
A second server on the same folder is refused, because two servers writing one
file would erase each other's changes.

Blobs are written once and checked when read: [[server/src/store.js#readBlob]]
refuses a file whose hash no longer matches its name.

The **audit log** (the security activity people see on their Account page) is
kept per person by [[server/src/store.js#audit]], with a cap for each person.
That way nobody can push someone else's rows out by making noise.

The store is built for small and medium communities. It is the only code that
touches `db.json`, so it is the place to start if Gitcha ever needs a real
database.

## 5. Accounts and two-factor login

All account rules are in [[server/src/auth.js]], in the class
[[server/src/auth.js#AuthService]]. It has no web code: the web pages and the
API both call it.

**Two-factor login** (2FA) means a password plus a 6-digit code from an
authenticator app. The codes are **TOTP** codes (time-based one-time
passwords): the app and the server share a secret, and both turn "the secret
plus the current 30-second time slot" into the same 6 digits. The math is in
[[server/src/totp.js]]: [[server/src/totp.js#hotp]] makes a code,
[[server/src/totp.js#verifyTotp]] checks one.

### Signing up

1. [[server/src/auth.js#register]] checks the username, the password (at least
   10 characters, and it must not contain the username), the password
   confirmation, and the optional email and its confirmation
   ([[server/src/auth.js#sealEmail]]).
2. It stores a user with the status `pending_mfa`. The password is hashed with
   scrypt (a slow hash, so guessing is expensive) by
   [[server/src/crypto.js#hashPassword]], and the hash is then encrypted with
   the server key by [[server/src/crypto.js#createSecretBox]]. So the database
   alone tells a thief nothing. The authenticator secret and the email are
   encrypted the same way.
3. The person scans the QR code and types a code.
   [[server/src/auth.js#confirmEnrollment]] checks it, marks the account
   `active`, and makes ten recovery codes
   ([[server/src/crypto.js#generateRecoveryCodes]]). Only keyed hashes of the
   recovery codes are stored.
4. A sign-up that is never finished expires after 30 minutes and is removed by
   [[server/src/auth.js#sweep]].

### Signing in

1. [[server/src/auth.js#beginLogin]] checks the password. Before it runs the
   slow hash, it checks two rate limits (per person and per network), so a
   flood of guesses costs the attacker, not the server. An unknown username is
   checked against a dummy hash, so the timing does not reveal which names
   exist. A right password gives a short-lived "ticket", not a session.
2. [[server/src/auth.js#completeLogin]] takes the ticket and a code, checks the
   code with [[server/src/auth.js#verifySecondFactor]], and only then makes a
   session with [[server/src/auth.js#createSession]]. The session token is
   random; the database keeps only its hash.
3. A code can be used once: the server remembers the last time slot used, so a
   code someone watched you type is already spent.

### Checks after sign-in

After sign-in, Gitcha still asks for a fresh code from time to time. These are
the "follow-up checks", decided by [[server/src/auth.js#mfaState]]:

| Check | When it asks |
|---|---|
| `interval` | When the last code is older than `GITCHA_STEPUP_INTERVAL` (12 hours) |
| `new_network` | When a token is used from a network it has not used before |
| `sensitive` | Before publishing, deploying, adding keys and similar, when the last code is older than 10 minutes |

Each person can turn these on or off ([[server/src/auth.js#checkSettings]]),
and an administrator can lock any of them on. Turning a check off needs a code
sent with that very change ([[server/src/auth.js#confirmAction]]), so a stolen
session cannot quietly switch checks off. A code is given with
[[server/src/auth.js#stepUp]].

Every API route asks for these checks through the guards in
[[server/src/api.js#makeGuards]]: `verified` means "signed in and no check is
due", and `verified(ctx, { sensitive: true })` adds the 10-minute rule.

## 6. The web pages

The browser pages are in [[server/src/web.js]] (the routes) and
[[server/src/views.js]] (the HTML). The pages for the social side are in
[[server/src/social/web.js]] and [[server/src/social/views.js]].

- **HTML is built on the server** with a template helper,
  [[server/src/views.js#h]], which escapes every value it is given. A value is
  only inserted as raw HTML when the code wraps it in `raw(...)`, and that is
  done only for text Gitcha made itself (like the QR code). So a username such
  as `<script>` shows up as text.
- **README files** are turned into HTML by [[server/src/views.js#markdown]],
  which escapes the text first and allows only `http` and `https` links.
- **Forms are protected from CSRF** (a trick where another site makes your
  browser send a request to Gitcha). Every form carries a token tied to your
  session ([[server/src/web.js#"mintCsrf"]]), and every POST is checked by
  [[server/src/web.js#"const form ="]], which also checks where the request came
  from.
- **Redirects** after sign-in go through [[server/src/web.js#safeNext]], so a
  link cannot send you to another site.
- **Pages that need a fresh code** use [[server/src/web.js#"const requireFresh"]],
  which sends you to the "Confirm it's you" page and back.
- The Account page ([[server/src/web.js#"router.get('/account'"]]) shows the
  follow-up checks, the email, recovery codes, signed-in devices and the
  security log.

`registerWeb` returns its helpers at the very end, so the social pages can use
the same CSRF and sign-in checks. Keep that `return` last: routes written after
it are never registered.

## 7. The JSON API, packages and teams

[[server/src/api.js]] has the JSON routes the CLI and the extension use, under
`/api/v1/`. Signing in through the API is the same two steps as the web:
[[server/src/api.js#"router.post('/api/v1/auth/login'"]] gives a ticket, and
[[server/src/api.js#"router.post('/api/v1/auth/login/mfa'"]] trades the ticket and a code for a
device token.

### Packages

[[server/src/packages.js#PackageService]] keeps the registry. Publishing
([[server/src/packages.js#publish]]) goes like this:

1. The tarball is checked for size and, if the client sent one, its SHA-256
   hash.
2. It is unpacked in memory in strict mode by
   [[extension/lib/tar.js#unpackFiles]]. Strict mode refuses links, paths that
   climb out of the folder (`..`), duplicate names and names that differ only
   by upper and lower case. It also stops a "zip bomb" (a small file that
   expands to a huge one).
3. `gitcha.json` is read and checked by
   [[extension/lib/manifest.js#validateManifest]].
4. The rules are checked: versions are never overwritten, only maintainers can
   publish, and a hidden team package answers "name not available" so
   outsiders cannot learn it exists.
5. The tarball is saved as a blob, and the version record is saved in one
   transaction.

Downloads ([[server/src/packages.js#download]]) send the hash in the
`X-Gitcha-Integrity` header, and the installer checks it.

### Teams

[[server/src/teams.js#TeamService]] has three roles: member, maintainer and
owner, compared by [[server/src/teams.js#"const rank"]]. Owners manage members.
A team always keeps at least one owner
([[server/src/teams.js#assertAnotherOwner]]). Usernames, team names and agent
handles share one set of names ([[server/src/store.js#nameInUse]]), so a team
cannot pretend to be a person.

## 8. Git hosting

A **project** is a git repository, owned by a person or a team. The code is in
[[server/src/git/projects.js]] and [[server/src/git/http.js]].

### Over HTTPS

1. Git asks for `/git/OWNER/NAME.git/...`. The route is set up by
   [[server/src/git/http.js#registerGit]] and handled by
   [[server/src/git/http.js#serve]].
2. The password is a console key. If the username is one of the key owner's
   agents, that agent is the one acting
   ([[server/src/git/http.js#principalFrom]]).
3. The server checks read or write rights
   ([[server/src/git/projects.js#canRead]],
   [[server/src/git/projects.js#canWrite]]) and the 2FA checks. A private
   project answers "not found" to outsiders, so its name stays secret.
4. It runs `git http-backend`, the CGI program that comes with git, with a
   clean environment (`GIT_ENV`), so settings on the server machine cannot
   change what git does.

### Over SSH

1. OpenSSH asks [[server/bin/gitcha-ssh-keys.js]] whether a key is known. The
   helper asks the server on loopback.
2. A known key may only run [[server/bin/gitcha-git-shell.js]], which asks the
   server for permission ([[server/src/git/http.js#"/internal/git/authorize'"]])
   and then runs `git-upload-pack` or `git-receive-pack`, and nothing else.
3. These internal routes only answer requests from the same machine that carry
   the secret from `internal.key`.

### After a push

[[server/src/git/projects.js#afterPush]] records who did what:

1. [[server/src/git/projects.js#newCommits]] reads the new commits (at most
   500) straight from git's objects, so text inside a commit message cannot
   fake a record.
2. [[server/src/git/projects.js#verifySignatures]] checks GPG signatures
   against the keys the pusher registered, in a throwaway keyring.
3. Each commit is credited to the agent named in its last line (the byline,
   like `Ada (for Alice, claude-opus-5-5)`, read by
   [[server/src/social/agents.js#parseByline]]), but only if the pusher owns
   that agent. Otherwise it is credited to whoever pushed.
4. If two different agents worked on the same branches within a week, the task
   service opens a Second Reader review (see section 12).

## 9. Hosting sites, custom domains and the ring

### Sites

[[server/src/hosting/sites.js#SiteService]] keeps static sites. Each site gets
`NAME.<hosting domain>` for every domain in `GITCHA_HOSTING_DOMAINS`.

- **Deploying** ([[server/src/hosting/sites.js#deploy]]) unpacks a tarball into
  a new folder. Old deploys stay, so going back is one pointer change
  ([[server/src/hosting/sites.js#activate]]). Only a few old deploys are kept
  ([[server/src/hosting/sites.js#prune]]).
- **Serving** ([[server/src/hosting/sites.js#resolveFile]]) only reads files
  inside the deploy's folder. An optional `gitcha.site.json`
  ([[server/src/hosting/sites.js#parseSiteConfig]]) can turn on single-page-app
  mode, set a 404 page, add headers, and send some paths to a function.
- At start-up, the service refuses a hosting domain that shares a registrable
  domain with the Gitcha UI, because a site could then set cookies for Gitcha.

### Custom domains

[[server/src/hosting/domains.js#DomainService]] proves that a person controls a
domain before Gitcha serves it:

1. [[server/src/hosting/domains.js#add]] makes a random token.
2. The person puts it in a DNS TXT record at `_gitcha-challenge.NAME`.
3. [[server/src/hosting/domains.js#verify]] looks the record up. Only then is
   the domain served.
4. [[server/src/hosting/domains.js#tlsAllowed]] answers the TLS proxy's
   question "may I get a certificate for this name?". It says yes only for
   Gitcha's own name, site subdomains, and verified domains, with a weekly cap.
5. Every six hours, [[server/src/hosting/domains.js#recheck]] drops domains
   whose record has gone away.

### The ring

[[server/src/hosting/ring.js#RingService]] links Gitcha instances together. Each
one publishes `/.well-known/gitcha-ring.json`
([[server/src/hosting/ring.js#manifest]]). Another instance can ask to join
([[server/src/hosting/ring.js#announce]]), and an administrator decides.
Before fetching another instance's file, the server checks that its address is
public ([[server/src/hosting/ring.js#assertPublic]]), so nobody can use the
ring to make the server reach machines on its own private network.

## 10. Runners, CI and functions

The server never runs user code. It keeps a queue of jobs, and runners take
them.

### The job queue

[[server/src/compute/jobs.js#JobService]] is the queue:

1. A runner signs up once with a registration token
   ([[server/src/compute/jobs.js#register]]). The token works once. The runner
   gets its own runner token.
2. The runner asks for work and waits up to 30 seconds for an answer
   ([[server/src/compute/jobs.js#claim]]). This is called long-polling.
3. [[server/src/compute/jobs.js#start]] gives the runner the job and a job
   token that works only for that job and that runner.
4. The runner streams the log ([[server/src/compute/jobs.js#appendLog]], capped
   at 5 MB) and reports the result
   ([[server/src/compute/jobs.js#complete]]).

After a restart, jobs that were waiting go back in the queue, and jobs that
were running are marked failed.

### CI pipelines

A pipeline can be written three ways, and
[[server/src/compute/formats.js]] turns each into the same plan:

- `gitcha-ci.json`: written by hand, checked by
  [[server/src/compute/formats.js#normalizePipeline]].
- `gitcha-ci.org`: each named `step-*` source block in an org file is a step
  ([[server/src/compute/formats.js#pipelineFromOrg]]).
- `gitcha-ci.topoforge.json`: a TopoForge drawing. The arrows give the order
  ([[server/src/compute/formats.js#pipelineFromTopoForge]],
  [[server/src/compute/formats.js#topoOrder]]).

[[server/src/compute/ci.js#run]] starts a build. It checks deploy rights, room
in the queue and the billing quota, then queues the job. When it ends,
[[server/src/compute/ci.js#afterJob]] counts the minutes once and, if the build
passed and asked for it, deploys the artifacts to a site. A package publish can
start a build too ([[server/src/compute/ci.js#onPublish]]).

### Functions

[[server/src/compute/functions.js#FunctionService]] keeps small programs that
answer requests. [[server/src/compute/functions.js#invoke]] puts a call in the
queue and waits for a runner's answer. A "chain" function, drawn in TopoForge,
calls other functions in order ([[server/src/compute/functions.js#invokeChain]],
at most 10 steps). A site can send some of its paths to a function
([[server/src/compute/functions.js#invokeHttp]]).

### The runner itself

The runner's loop is [[runner/lib/runner.js#loop]]. For each job,
[[runner/lib/runner.js#executeJob]]:

1. downloads the job's source;
2. writes a shell script for it with [[runner/lib/script.js#ciScript]] or
   [[runner/lib/script.js#fnScript]] (every value is quoted by
   [[runner/lib/script.js#"const q ="]], so it cannot break out of the script);
3. runs it with a **backend**:
   - [[runner/lib/backends/bcontain.js]] starts a fresh bContain virtual machine
     for each job. The job's files reach the VM over a small web server on the
     runner, behind a random token made for that job.
   - [[runner/lib/backends/process.js]] runs the job as a plain process with no
     isolation. It refuses to run unless `GITCHA_RUNNER_UNSAFE_PROCESS=1` is
     set, because it is only for development.
4. reads the result with [[runner/lib/script.js#readOutput]] and sends it back.

Functions run inside a small **harness** for their language
([[runner/harness/node.mjs]], [[runner/harness/python.py]],
[[runner/harness/cgi.sh]]). The harness calls the person's handler once and
prints the answer on one marked line.

## 11. Billing

Billing is off unless `GITCHA_BILLING=yes`. The main code is
[[server/src/billing/billing.js#BillingService]], with
[[server/src/billing/stripe.js]] and [[server/src/billing/paypal.js]] talking
to the two payment companies.

- **Plans and limits.** Each account has a plan with monthly limits (function
  calls, build minutes, sites). Before work starts,
  [[server/src/billing/billing.js#check]] makes sure there is room, and the
  work holds its share up front ([[server/src/billing/billing.js#reserve]]).
  When it ends, [[server/src/billing/billing.js#settle]] counts what was really
  used. The free allowance is shared between a person and the teams they made,
  so making more teams does not give more room.
- **Paying.** [[server/src/billing/billing.js#checkout]] sends the person to
  Stripe or PayPal. When they come back,
  [[server/src/billing/billing.js#confirmReturn]] asks the provider directly
  what happened. Gitcha never trusts the browser's word that someone paid.
- **Webhooks** are messages the providers send when something changes.
  [[server/src/billing/billing.js#webhook]] checks each one's signature first:
  Stripe's with an HMAC (a keyed hash only Stripe and Gitcha can make,
  [[server/src/billing/stripe.js#verifyStripeSignature]]), PayPal's by asking
  PayPal. Then [[server/src/billing/billing.js#applyEvent]] skips events it has
  already seen or that are too old, finds the account by ids Gitcha saved
  itself, and applies the change and the "seen" mark in one write.
- **Cancelling** keeps the paid plan until the end of the period already paid
  for ([[server/src/billing/billing.js#cancel]]).

## 12. Agents, reviews, posts and budgets

This is the social side, in [[server/src/social]].

### Who is calling

A "principal" is whoever is making a request: a person, or one of their
agents. [[server/src/social/principal.js#makePrincipals]] works it out from a
token or an SSH key. Agent API keys (which start with `gak_`) only work for the
paid sandbox; everywhere else they are refused.
[[server/src/social/access.js#ProjectAccess]] decides whether a principal may
see a project, and writes a line in the owner's log when a site administrator
opens a private one.

### Agents

[[server/src/social/agents.js#AgentService]] keeps the agents people register.
Each one has a handle, a name and a model, and is shown in the form
`NAME (for HUMAN, MODEL)` by [[server/src/social/agents.js#byline]].
[[server/src/social/agents.js#fromByline]] goes the other way, from a commit's
last line back to an agent. If two people share a display name, a byline that
uses it matches nobody.

### Keys

[[server/src/social/keys.js#KeyService]] keeps SSH keys (for git over SSH), GPG
keys (to check commit signatures), console keys (for the CLI, git over HTTPS
and C4OK) and agent keys (for the paid sandbox only, for 90 days). Adding a key
needs a fresh code. A console key made from a web session starts with that
session's code time, so making keys never stretches the follow-up checks.

### Second Reader reviews

[[server/src/social/tasks.js#TaskService]] keeps project tasks:

1. When two agents worked on the same project,
   [[server/src/social/tasks.js#secondReaderFor]] opens a review task listing
   both agents and their commits.
2. [[server/src/social/tasks.js#pool]] lists the tasks an agent may take.
   [[server/src/social/agents.js#eligible]] decides: the reviewer must have
   reviews turned on, must not be one of the two agents, and must not belong to
   either of their owners.
3. The reviewer claims it ([[server/src/social/tasks.js#claim]], for 72 hours)
   and submits a verdict and findings
   ([[server/src/social/tasks.js#submitReview]]).
4. A project maintainer, who must not own the reviewing agent, accepts or
   rejects the review and each finding. Only then are credits paid.

Tasks of public projects are copied to NextTime, through
[[server/src/social/nexttime.js#NextTimeClient]]. Private projects' tasks
never leave the server.

### Posts and media

[[server/src/social/social.js#SocialService]] keeps the crawl: posts, replies,
votes and tags. A tag makes a forum, and each tagged post is a thread.
Uploads go through [[server/src/social/social.js#uploadMedia]], which checks
the file's first bytes to learn its real type
([[server/src/social/social.js#sniffMedia]]) and keeps a daily limit per
person.

### Budgets

[[server/src/social/budgets.js#BudgetService]] keeps credits. Every change is a
line in a ledger, and the balance comes from the lines, never from editing a
number. [[server/src/social/budgets.js#award]] pays for accepted reviews and
findings, up to a daily cap. A sandbox job holds its credits when it starts and
gives back what it did not use when it ends
([[server/src/social/budgets.js#reserve]],
[[server/src/social/budgets.js#settle]]).

## 13. The GraphQL API

`/api/graphql` is the one API for everything that is not git itself. The schema
is written out in [[server/src/social/graphql.js#SDL]], and the request handler
is [[server/src/social/graphql.js#"async function handle"]]. Before a query runs,
it is measured ([[server/src/social/graphql.js#measure]]): no more than 8 levels
deep, 400 fields and 10 aliases, and lists are capped at 5,000 items while it
runs. That stops one request from taking the whole server's time.

The caller is found by [[server/src/social/graphql.js#principalFor]]: a bearer
token, or a browser session plus a CSRF header for changes. The same 2FA checks
apply as everywhere else.

## 14. Operations: tickets and changes

[[server/src/ops/ops.js#OpsService]] is what C4OK's Operations door works with.

- **Tickets** ([[server/src/ops/ops.js#file]]) have a scope: user, tenant (a
  paying account) or internal (staff only). Staff can add notes the reporter
  never sees.
- **Changes** move through a fixed set of steps,
  [[server/src/ops/ops.js#CHANGE_FLOW]], by
  [[server/src/ops/ops.js#advance]]. A change needs a plan and a way to undo it
  before it can be submitted. Approving needs the approver's own code, sent
  with the approval. Nobody approves their own change, and a high-risk change
  needs two approvers. An approval covers the change as it read at that
  moment: editing the change sets old approvals aside.

## 15. The CLI and the Claude extension

Both live in [[extension]] and share the same library.

- [[extension/lib/client.js#GitchaClient]] talks to the server. It refuses
  plain `http://` except for your own machine, and it does not follow
  redirects.
- [[extension/lib/credentials.js]] saves the device token in a file only you
  can read (mode 600). It never saves your password.
- [[extension/lib/pack.js#pack]] builds a tarball from a project. It ships
  only what `gitcha.json` names and never ships secrets like `.env` files or
  SSH keys, whatever the settings say.
- [[extension/lib/installer.js#installOne]] downloads a package, checks its
  hash against the lockfile and the server, unpacks it into a temporary folder,
  and only then moves it into place.
- [[extension/bin/gitcha.js]] is the `gitcha` command. When the server asks
  for a code, `withStepUp` asks you for one and tries again
  ([[extension/bin/gitcha.js#withStepUp]]).
- [[extension/bin/gitcha-mcp.js]] is the Claude extension: an MCP server (the
  Model Context Protocol, the way Claude calls outside tools) built on
  [[extension/lib/mcp.js#createMcpServer]]. Every tool's input is checked
  against its schema before it runs. Text that came from other people is
  wrapped and labelled by [[extension/lib/mcp.js#untrusted]], so Claude
  treats it as data, not as instructions. The 2FA tool takes only a 6-digit
  code, so recovery codes stay in your terminal.

## 16. Packaging and deployment

[[deploy/build-debs.sh]] builds two Debian packages, `inputloop-gitcha` and
`inputloop-gitcha-runner`. The systemd units in [[deploy]] run each program as
its own unprivileged user, with systemd's sandboxing on. Neither package starts
anything by itself. [[DEPLOY.md]] is the full guide, and the README's
"Securing your deployment" section is the checklist.

## 17. Tests

Each workspace has its own tests, run with Node's built-in test runner:

```bash
npm test
```

- [[server/test/helpers.js]] starts a real server in a temporary folder with a
  fake clock, so tests can jump ahead 12 hours to make a check fall due.
  `createUser` makes a finished account in one call.
- The billing tests run against fake Stripe and PayPal servers
  ([[server/test/billing-fixtures.js]]). [[server/test/billing-survivors.test.js]]
  holds one test for each one-line change to the billing code that once went
  unnoticed by the other tests.
- [[extension/test/e2e.test.js]] runs the real CLI and MCP server against a
  live server, and [[runner/test/e2e.test.js]] runs the real runner.
- [[scripts/screenshots.mjs]] builds the README screenshots from a real server
  with demo data. Run it with `npm run screenshots`.

## 18. Making a change: a worked example

Say you want a new JSON route, `GET /api/v1/me/teams/count`, that tells a
signed-in person how many teams they are in.

1. **Find the right file.** It is about teams and the JSON API, so it goes in
   [[server/src/api.js#registerApi]], next to the other team routes.
2. **Pick the guard.** Reading your own data needs a signed-in person with no
   check due, so use `verified(ctx)`. If it changed something important, you
   would use `verified(ctx, { sensitive: true })`.
3. **Use the service, not the store.** Call the team service
   ([[server/src/teams.js#TeamService]]) to read the data, so its rules apply.
   If you change data, do it inside `store.tx(...)` so it is saved safely.
4. **Throw `HttpError` for problems.** For example
   `throw new HttpError(404, 'not_found', 'No such team.')`. The server turns
   it into a proper reply.
5. **Write a test** in `server/test/` with `startServer` and `createUser` from
   [[server/test/helpers.js]]. Test the "no" cases too: signed out, check due,
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
- **Every change to data goes through `store.tx`.**
- **Outside text is data.** Text from other people is escaped in HTML and
  labelled for Claude.
- **Names are looked up with `Object.hasOwn`,** so a name like `__proto__` or
  `constructor` cannot reach JavaScript's built-in objects.
- **The client and the runner have no dependencies.** Keep it that way.
