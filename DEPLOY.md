<!-- SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Corwin Brust <corwin@bru.st> and Contributors -->
<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# Deploying Gitcha

This guide is for whoever runs a Gitcha instance: first for Corwin, putting the hosting
builds on alphaOS VMs on the ghostwheel, and then for anyone who self-hosts and joins the ring.

## The shape of it

```
            people, agents, git, browsers
                          |
                 TLS proxy (Caddy, :443)          asks Gitcha before any certificate
                          |
          gitcha-server on 127.0.0.1:4873         never runs user code
           | data: /var/lib/gitcha (db.json, git/, sites/, blobs/, logs/, secret.key)
           |
   long-poll over HTTPS (runner token)
           |
   gitcha-runner on a separate VM                 each job in its own bContain VM
```

- **The server** keeps accounts, repositories, packages, sites, tickets and the queue. It
  serves static sites itself (files only), and it never executes anything a user wrote.
- **Runners** take CI jobs and function invocations from the queue and run each in a fresh
  bContain VM. Run them on their own VMs, apart from the server and from the internal
  ghostwheel, so tenant code never shares a machine with tenant data it should not see.
- **Hosted names** (sites' subdomains and verified custom domains) are answered by the
  hosting layer only: they never reach the Gitcha UI or API, so a user's script cannot act
  as the person viewing it.

## Packages

```sh
sh deploy/build-debs.sh out/
```

This builds `inputloop-gitcha` and `inputloop-gitcha-runner` with plain `dpkg-deb`, no root,
in alphaOS's idiom: version `X.Y.Z+git<sha7>`, maintainer `inputloop`, and no service started
or enabled by the package. The server's two npm dependencies come from the committed
lockfile at build time.

### Putting them in alphaOS

alphaOS builds its parts in `packaging/build-debs.sh` and enables services in
`packaging/build-iso.sh`. These are Corwin's files, so this is a proposal to take or leave,
not a change made there:

1. Add `inputloop/gitcha` to `repos.tsv` at the commit to ship.
2. Add a part that calls Gitcha's own script, so there is one recipe:
   ```sh
   part_gitcha() {
     d=$(find_src gitcha)
     sh "$d/deploy/build-debs.sh" "$OUT"
   }
   ```
   and add `gitcha` to `PARTS`.
3. For a hosting VM image, enable the server in `build-iso.sh`'s `systemctl enable` line
   (`gitcha`), and for a runner VM image, `gitcha-runner`. The default kiosk image should
   enable neither.

alphaOS binds everything to loopback and C4OK refuses network listening without an explicit
setting. Gitcha keeps that posture: it listens on `127.0.0.1:4873`, and only the TLS proxy
listens publicly. That proxy is the one deliberate exception a hosting VM makes, and it should
be named as such in alphaOS's security model.

## The server

1. `apt install ./inputloop-gitcha_*.deb`
2. Edit `/etc/inputloop/gitcha/gitcha.env` (a conffile, readable by root and the `gitcha`
   group). At least `GITCHA_PUBLIC_URL`, and `GITCHA_HOSTING_DOMAINS` for hosting.
3. `systemctl enable --now gitcha`
4. Open the public URL and register. **The first account becomes the administrator.**
5. Set `GITCHA_OPEN_REGISTRATION=false` afterwards if sign-up should be closed.

### Running it

- **Firewall:** open 443 and 80 for the proxy, and 22 if you offer git over SSH; nothing else (4873 stays on loopback).
- **`GITCHA_TRUST_PROXY=true`** makes Gitcha believe `X-Forwarded-For`; turn it on only when the proxy on this host is the one way in, or anyone can choose the address that rate limits and the new-network check see.
- **Upgrades:** the package restarts a running `gitcha` itself (`systemctl try-restart`); if you installed the new code any other way, run `systemctl restart gitcha`, or a security fix is installed and not live.
- **One process per data directory:** the database is one file held in memory, so a second server on the same directory (a hand-started `gitcha-server` beside the unit, a second container on the volume) silently loses accounts.
- **`GITCHA_LOCKED_CHECKS`** is a comma list of the two-factor checks people cannot turn off (`interval`, `new_network`, `sensitive`); it is empty unless you set it.
- **Limits in the units:** the server unit caps memory at 2G and tasks at 512, the runner's at 6G and 1024, and both allow only `AF_UNIX`, `AF_INET` and `AF_INET6`. They are the keepers' numbers: change them with `systemctl edit`. The runner's unit also drops every capability, which has not been tried against a real bContain job yet.
- **Settings:** `gitcha.env` lists every setting the server reads, with its default on a `#` line.
- **Docker:** the image has `git` and `gpg`, no sshd, so there is no git over SSH there.

### TLS and DNS

`/usr/share/doc/inputloop-gitcha/Caddyfile.example` puts Caddy in front: a wildcard
certificate for each hosting domain, and on-demand certificates for everything else. Caddy
asks `GET /api/v1/hosting/tls-allowed?domain=NAME` before ordering one, and Gitcha says yes
only for its own name, custom domains whose DNS check passed and still passes (Gitcha looks
again every six hours and drops a domain after three misses in a row), and, as a stopgap for
instances without a wildcard certificate, a site's subdomain while its owner has ordered fewer
than ten new ones this week. A public CA caps how many certificates one registered domain may
order per week, so use the wildcard certificate (it needs the DNS challenge, so a Caddy build
with your DNS provider's module); an account may also hold at most 25 sites whatever the
billing setting.

`gitcha.env` sets `GITCHA_TRUST_PROXY=true`, which is right for this Caddyfile: Caddy replaces
`X-Forwarded-For` with the client's address and Gitcha trusts one proxy hop. With nginx instead,
set `proxy_set_header X-Forwarded-For $remote_addr;` (the README has the whole block); if another
proxy sits in front of yours, say how many with `GITCHA_TRUSTED_PROXIES`.

DNS records to create:

| Record | Points at | Why |
|---|---|---|
| `gitcha.example.org` A/AAAA | the server VM | the UI, API and git |
| `*.pages.example.net` A/AAAA | the server VM | every site's subdomain (one wildcard per hosting domain) |
| `hosting.example.net` A/AAAA | the server VM | optional: the CNAME target shown to people with custom domains (`GITCHA_HOSTING_CNAME`) |

Use hosting domains that are **separate registrable domains** from the UI's, so a site's
scripts cannot set cookies for Gitcha. Gitcha refuses to start when a hosting domain shares a
registrable domain with `GITCHA_PUBLIC_URL`. It guesses that from the last two labels (three
under a country code such as `co.uk`); it carries no copy of the Public Suffix List. Sites on
one hosting domain are still "same-site" with each other unless that domain is on the Public
Suffix List, so a keeper who wants tenants kept apart from one another should have it added
(https://publicsuffix.org/submit/).

The keepers already hold several names (ils4 lists `ghostwheel.cloud`, whose wildcard points
at gw10 today with a certificate for the apex only; `ghostwheel.chat`, `gwhee.lol`,
`inputloop.com`, `gsus.work`, `vibrobea.st` and `bru.st`). Which of them serve Gitcha, and as
which role, is the keepers' choice; ils4 says records are written by tool, never by hand in a
panel.

**Custom domains.** A person adds a domain to a site. Gitcha shows a TXT record
(`_gitcha-challenge.NAME` = `gitcha-verify=...`) and a CNAME target. Once the TXT record
resolves, they press verify, and only then is the domain served and allowed a certificate.
Until then it is only a claim: several people may claim one name, a claim lapses after a day,
and an account holds at most ten waiting claims and 25 domains. Whoever proves DNS control
first gets the name, and a later proof from another site takes it over. A verified domain is
dropped when its TXT record has been gone for three checks in a row.

### Git over SSH

Copy `/usr/share/doc/inputloop-gitcha/sshd-gitcha.conf.example` to
`/etc/ssh/sshd_config.d/gitcha.conf`, set `GITCHA_SSH_HOST` and `GITCHA_SSH_USER=git` in
`gitcha.env`, and reload sshd. OpenSSH asks `gitcha-ssh-keys` for the offered key's
fingerprint; a known key is forced through `gitcha-git-shell`, which runs only
`git-upload-pack` or `git-receive-pack`, and only where that person or agent may. Both
helpers talk to the server on loopback with a secret from `/var/lib/gitcha/internal.key`.
Port 22 must be open in the firewall for this (the proxy's 443 and 80 are not enough).

**The SSH user must not be the account the server runs as.** SSH-served git runs outside the
server unit's sandbox, as whoever sshd runs it as; as `gitcha` that is the account that owns
`db.json`, `secret.key` and `internal.key`. Use two: `gitcha` runs the daemon and owns the
data; `git`, a system account in group `gitcha` with no password, is the SSH login. It needs
to read `internal.key` (mode 640, group `gitcha`) and to read and write the repositories under
`/var/lib/gitcha/git` (group-writable, set-gid, repositories `core.sharedRepository=group`),
and `/var/lib/gitcha` itself must be traversable by the group (750). Nothing else in that
directory should be group-readable. If git refuses a repository as "dubious ownership", set
`safe.directory` in the `git` account's own git config, not in the server's.

Pushes and reads over SSH meet the same periodic two-factor check as HTTPS: when it is due
(no code entered on any of the person's devices within the step-up interval), the helper
prints "run `gitcha verify`" and refuses. An agent's SSH key acts as the agent, as an agent
key does.

Status: built and unit-checked; **not yet run against a real sshd, nor with the two
accounts** (the machine this was written on had no sshd).

### Backups

Back up `/var/lib/gitcha`. Keep `secret.key` apart from the database backups: passwords
(as AES-256-GCM-sealed scrypt hashes) and authenticator secrets are encrypted with it, so the
database alone is useless to a thief, and the database without the key is useless to you.

To restore, put back `db.json` **and the `secret.key` that was current when it was saved** (or set
`GITCHA_SECRET_KEY` to it). The server will not start on a `db.json` that holds accounts when it has no key:
it prints `gitcha: cannot start: ...` and exits 1 instead of making a new key, which would lock every
account out. It also refuses a `db.json` it cannot read and a key file that is empty or not 32 bytes in
base64. A new key is made only on a first start, or when `db.json` holds no accounts.

Run **one server per data directory**. The server takes `db.lock` (its process id) when it starts and a
second server on the same directory exits with `another process (pid N) is already using ...`; a lock left
by a crashed or killed server is recognised as dead and taken over. If a different, unrelated process now
has that pid and the message is wrong, delete `db.lock`. `db.json` is replaced atomically and synced to
disk on every change, so copying it while the server runs gives a consistent file; leftover `*.tmp`
files from a crash are removed at start, and a `db.json` that is not valid JSON stops the start with the
file's name rather than being overwritten.

## Runners

1. Install bContain on the runner VM and check it: `bcontain doctor`. The runner VM needs
   `/dev/kvm`; inside a VM that means nested virtualization on the host, or bContain falls
   back to software emulation, which is slow.
2. `apt install ./inputloop-gitcha-runner_*.deb`
3. In Gitcha, an administrator creates a registration token (`POST
   /api/v1/runners/registrations`; team owners can create one for a team runner). It works
   for one runner and for an hour (`{"uses": 5}` lets a fleet share one, up to 20);
   `GET /api/v1/runners/registrations` lists the ones still open and `DELETE
   /api/v1/runners/registrations/ID` revokes one.
4. Register and start:
   ```sh
   sudo -u gitcha-runner GITCHA_RUNNER_HOME=/var/lib/gitcha-runner \
     gitcha-runner register --server https://gitcha.example.org --token TOKEN --name "$(hostname)" --backend bcontain
   systemctl enable --now gitcha-runner
   ```

What bContain gives each job: its own VM, CPU and memory caps, nothing kept afterwards.
What it does not give yet, and Gitcha does not pretend otherwise: the guest has outbound
network access (there is no network-off switch), everything inside runs as root, and there
are no disk quotas. The job's files reach the VM over QEMU's user-mode gateway
(10.0.2.2) behind a one-time token, because bContain has no volume mounts yet.

Status: the command line and the parsing of the VM's console are unit-tested against
bContain's source; **no job has yet run inside a real bContain VM**. That is the first thing
to try on the ghostwheel.

### orgvm functions

Functions with `runtime: "orgvm"` are accepted only when `GITCHA_ORGVM=yes`, and run only on
runners labelled `orgvm`. A runner gets that label when `GITCHA_ORGVM_CMD` is set: the command
receives the org file, the block name and the request, and prints the response line. It is
the seam for Corwin's jail ("user lambda in a jail that is an emacs session in own docker
container"), which does not exist yet; until it does, org-file functions run their named block
as node, python or sh.

## Billing

Off unless `GITCHA_BILLING=yes`. Then:

- **Stripe:** create a Product with a recurring Price per paid plan, set `STRIPE_PRICE_PRO`
  (and `STRIPE_PRICE_TEAM`), `STRIPE_SECRET_KEY`, and a webhook to
  `https://gitcha.example.org/api/v1/billing/stripe/webhook` for `checkout.session.completed`,
  `customer.subscription.*` and `invoice.payment_failed`; put its signing secret in
  `STRIPE_WEBHOOK_SECRET`. Turn on the customer portal in the Stripe dashboard.
- **PayPal:** create a Product and a Billing Plan per paid plan, set `PAYPAL_PLAN_PRO` (and
  `PAYPAL_PLAN_TEAM`), `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENV=live`, and a
  webhook to `https://gitcha.example.org/api/v1/billing/paypal/webhook` for the
  `BILLING.SUBSCRIPTION.*` events; put its id in `PAYPAL_WEBHOOK_ID`.
- Plans and limits default to Free, Pro and Team; replace them with a JSON file named by
  `GITCHA_PLANS_FILE`.
- On start the server logs which mode each provider's keys are in (Stripe from the `sk_live_` or
  `sk_test_` prefix, PayPal from the API host). A subscription records the mode that wrote it, and
  one written with test keys is not a paid plan once the keys are live; the log counts them.
- An event is applied only to the subscription the account holds, found by the id Gitcha
  recorded, and in the provider's order; a late older event, an unknown subscription or a payment
  session Gitcha did not start is recorded as ignored (`billing.event_ignored` in the audit log).
  Changing plan keeps the old subscription until the new one is paid, then cancels it at the
  provider. A failed payment keeps the paid limits for seven days from the first failure, and so
  does a paid period that ran out without word from the provider; Gitcha asks the provider about
  those every few minutes (PayPal does not announce renewals).
- Deleting a team closes its billing account: its subscription is cancelled at the provider (a
  refused cancel is retried and logged) and a team that later takes the name starts on Free.

Keys live only in `gitcha.env`. Status: tested against fake Stripe and PayPal endpoints;
**not yet run against either provider's sandbox**. Do that first, with test keys.

A note for the keepers: ils4's M10 recommended "not now" for paid accounts and rejected an
open-core tier. Billing here is a switch, off by default, and every feature works without it;
what it sells is capacity (sandbox minutes, invocations, sites), not features.

## Operations and C4OK

Tickets and changes live in Gitcha; C4OK's Operations door (`/operations`, in
c4ok-PRIVATE `w/lib/gitcha.js`) is the kiosk for them.

1. In Gitcha, the administrator gives the operator's account the staff role (GraphQL
   `setRole`).
2. Signed in as that account, create a console key (GraphQL `createConsoleKey`, fresh code).
3. On the C4OK host, as C4OK's account: write the key to a file, `chmod 600` it, and set
   `C4OK_GITCHA_URL` and `C4OK_GITCHA_KEY` (the file's path) in C4OK's environment.

The console key follows Gitcha's 2FA checks like any device; when Gitcha asks, the door shows
a code form. Approving or rejecting a change always needs the approver's own Gitcha code.

## NextTime

Set all four `NEXTTIME_*` settings to mirror project tasks (including Second Reader reviews)
into a NextTime instance as timebank requests, through its existing API with a Nextcloud app
password. A new task creates a request; a task closed as `closed` cancels it; a task closed
as `done` completes it. Completion is a toggle, on by default: `NEXTTIME_COMPLETE=no` turns it
off. NextTime completes a request only after its requester (the Gitcha account in
`NEXTTIME_USER`) has accepted a volunteer there, and it then credits those volunteers' hours
in its public ledger. When NextTime refuses, Gitcha keeps the reason on the task (its
`nexttime` field) and closes the task anyway.

## Joining the ring

Every instance publishes `/.well-known/gitcha-ring.json`. To join another instance's ring,
ask it:

```sh
curl -X POST https://their.example/api/v1/ring/announce -H 'content-type: application/json' -d '{"url":"https://gitcha.example.org"}'
```

Their administrator approves it (GraphQL or `POST /api/v1/ring/decide`). To list peers
yourself, set `GITCHA_RING_PEERS`. Instances that sell things say so in their manifest
(`features.paid`), and the ring page shows it; members link to each other either way.

---
Copyright 2026 Bryant Frankford and Corwin Brust and Contributors. CC-BY-SA-4.0.

Alfred (for Bryant)
