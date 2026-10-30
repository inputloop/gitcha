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

- **The TLS proxy** (Caddy, nginx, Apache or HAProxy) is the only thing on ports 80 and 443. It
  does the https, the certificates and the client's address, and passes everything else to the
  server unchanged; "The reverse proxy" below says why and how. On a network you trust, Gitcha
  also runs without it ("Running without a reverse proxy").
- **The server** keeps accounts, repositories, packages, sites, tickets and the queue. It
  serves static sites itself (files only), and it never executes anything a user wrote.
- **Runners** take CI jobs and function invocations from the queue and run each in a fresh
  bContain VM. Run them on their own VMs, apart from the server and from the internal
  ghostwheel, so tenant code never shares a machine with tenant data it should not see.
- **Hosted names** (sites' subdomains and verified custom domains) are answered by the
  hosting layer only: they never reach the Gitcha UI or API, so a user's script cannot act
  as the person viewing it.

## Packages

There are two recipes. Both lay the files out with `deploy/lay-out.sh`, so they install the same
programs in the same places; they differ in what the package does when it is installed.

```sh
sh deploy/build-debian.sh out/                 # the full packaging: debian/, debhelper, debconf
sh deploy/build-debs.sh out/                   # alphaOS's idiom: plain dpkg-deb, no root, asks nothing
```

Both build `inputloop-gitcha` and `inputloop-gitcha-runner`, maintainer `inputloop`, and neither
enables or starts a service unless asked to. The server's npm dependencies come from the committed
lockfile at build time (so the build needs the npm registry, or a filled npm cache).

**Versions.** A package's version is `X.Y.Z+gitYYYYMMDDHHMMSS.<sha7>`: `package.json`'s version, the
commit's time (UTC), then the first seven characters of its hash, for example
`0.2.0+git20261030010555.cb60617` (`sh deploy/version.sh` prints it). The time comes first because
apt compares versions piece by piece: the hash alone (the scheme before 0.2.0) sorted by its letters,
so a newer commit could look older and apt would not upgrade to it. Two things follow:

- **Build the branch you mean.** The version names the commit that was checked out, so build `main`
  after `git pull` has brought the work in; `git log -1 --oneline` says which commit that is.
- **The same commit gives the same version.** apt then says `is already the newest version` and
  installs nothing: `apt install --reinstall ./inputloop-gitcha_*.deb` installs a rebuild anyway.
  `build-debs.sh` packs the working tree as it is and warns when it holds uncommitted changes;
  `build-debian.sh` builds only what is committed.

- **`build-debian.sh`** exports the committed tree (`git archive HEAD`), gives `debian/changelog` a
  snapshot entry and runs `dpkg-buildpackage`. It needs `debhelper` (13), `devscripts`, git and
  Node.js 20+ with npm. The packages ask their settings with **debconf** (below), keep them in
  `/etc/inputloop/gitcha/debconf.env`, and are lintian-clean. This is the one to put in an apt
  repository and install on many hosts.
- **`build-debs.sh`** is what alphaOS's image build calls. Its packages ask nothing: edit
  `gitcha.env` by hand.

**The build option: Apache Cassandra, on by default.** A default build carries the Cassandra
driver (`cassandra-driver`, Apache-2.0), ships `GITCHA_STORE=cassandra` and recommends the
`cassandra` package. To build without it, so the database is `db.json` and the driver is not in
the package:

```sh
sh deploy/build-debian.sh out/ --without-cassandra      # = dpkg-buildpackage -P pkg.gitcha.nocassandra
sh deploy/build-debs.sh out/ --without-cassandra
docker build --build-arg GITCHA_WITH_CASSANDRA=no .
npm ci --omit=optional                                   # from a checkout
```

Both packages depend on `nodejs (>= 20)`. Debian 12 and Ubuntu 24.04 ship Node 18, so those hosts
need Node from NodeSource (or Debian 13, which has 20).

### Installing many hosts

Three pieces, all in `deploy/`:

1. **An apt repository.** `sh deploy/apt-repo.sh REPO_DIR --sign KEYID out/*.deb` makes a signed
   flat repository (Packages, Release, InRelease and the public key as
   `inputloop-archive-keyring.gpg`). Serve `REPO_DIR` over HTTPS; run it again to add new builds.
2. **A preseed file.** `deploy/preseed.example.cfg` answers every debconf question of both
   packages: the public URL, hosting domains, the database (Cassandra nodes, data center,
   keyspace, this host's instance name, replication, credentials), whether to start the service,
   and for runners the server and a registration token. `@HOST@` and `@INSTANCE@` are filled in per
   host.
3. **`mass-install.sh`.** Given a hosts file (one SSH destination per line, optionally followed by
   that host's Cassandra instance name) it runs, on each host over one SSH connection, as root:
   `debconf-set-selections` with that host's answers, then `apt-get install` with no prompts. It
   works through 8 hosts at a time (`--parallel N`), keeps a log per host and prints ok or failed
   for each.

```sh
sh deploy/mass-install.sh servers.txt preseed.cfg \
  --repo https://apt.example.org/gitcha --keyring repo/inputloop-archive-keyring.gpg --package inputloop-gitcha
sh deploy/mass-install.sh runners.txt preseed.cfg --deb out/inputloop-gitcha-runner_*.deb
```

A runner fleet registers itself during installation: make one registration token with `uses` of
at least the number of runners, put it in the preseed file, and each runner trades it for its own
runner token (the registration token is used once and kept nowhere: not in debconf, not on the
command line). Change any answer later on one host with `dpkg-reconfigure inputloop-gitcha`.

Status: built and installed here from the signed repository, configured from a preseed file, run
on Cassandra 5.0.9, and a runner registered itself through `mass-install.sh` (with a stand-in
`ssh` that ran locally). **Not yet run over real SSH against separate hosts, nor under systemd**
(the machine had none), so the enable-and-start answer is untried.

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

1. `apt install ./inputloop-gitcha_*.deb`. The full packaging asks for the public URL, the
   hosting domains, the database and whether to start now (`dpkg-reconfigure inputloop-gitcha`
   asks again).
2. Edit `/etc/inputloop/gitcha/gitcha.env` (a conffile, readable by root and the `gitcha`
   group) for everything else. With `build-debs.sh` packages, set at least `GITCHA_PUBLIC_URL`
   there, `GITCHA_HOSTING_DOMAINS` for hosting, and the database settings.
3. `systemctl enable --now gitcha` (unless debconf already did), and put a reverse proxy in
   front ("The reverse proxy" below), or, on a trusted network only, run without one ("Running
   without a reverse proxy").
4. Open the public URL and register. **The first account becomes the administrator.**
5. Set `GITCHA_OPEN_REGISTRATION=false` afterwards if sign-up should be closed.

### Running it

- **Firewall:** open 443 and 80 for the proxy, and 22 if you offer git over SSH; nothing else (4873 stays on loopback).
- **`GITCHA_TRUST_PROXY=true`** makes Gitcha believe `X-Forwarded-For`; turn it on only when the proxy on this host is the one way in, or anyone can choose the address that rate limits and the new-network check see.
- **Upgrades:** the package restarts a running `gitcha` itself (`systemctl try-restart`); if you installed the new code any other way, run `systemctl restart gitcha`, or a security fix is installed and not live.
- **One process per data directory, and per Cassandra instance:** the database is held in memory and saved whole or row by row, so a second server on the same data (a hand-started `gitcha-server` beside the unit, a second container on the volume) would silently lose accounts. `db.lock` and the Cassandra lease stop it (see "The database").
- **`GITCHA_LOCKED_CHECKS`** is a comma list of the two-factor checks people cannot turn off (`interval`, `new_network`, `sensitive`); it is empty unless you set it.
- **Limits in the units:** the server unit caps memory at 2G and tasks at 512, the runner's at 6G and 1024, and both allow only `AF_UNIX`, `AF_INET` and `AF_INET6`. They are the keepers' numbers: change them with `systemctl edit`. The runner's unit also drops every capability, which has not been tried against a real bContain job yet.
- **Settings:** `gitcha.env` lists every setting the server reads, with its default on a `#` line.
- **Docker:** the image has `git` and `gpg`, no sshd, so there is no git over SSH there.

### When it does not start

**The proxy says "connection refused" (nginx: `connect() failed (111: Connection refused) while
connecting to upstream`, a 502 page in the browser):** nothing is listening on `127.0.0.1:4873`, so
the Gitcha server is not running. The proxy is fine; find out why Gitcha stopped:

```sh
sudo gitcha-check                       # tries what a start needs (settings, database, port) and says what fails
systemctl status gitcha                 # running, starting, or failed, and the last lines it printed
journalctl -u gitcha -e                 # everything it printed; -f follows it live
journalctl -u gitcha -b --no-pager | grep 'cannot start'   # just the reasons, since boot
curl -s http://127.0.0.1:4873/api/v1/health                 # does it answer on this machine?
ss -ltnp | grep 4873                    # what is listening on the port
```

Gitcha logs to the systemd journal (standard output), not to a file under `/var/log`. Every failed
start prints one line beginning `gitcha: cannot start:` with the reason, and the line before it says
which database it was opening. `systemctl start gitcha` waits until Gitcha answers on its port, so a
start that fails says `Job for gitcha.service failed` at once; systemd then tries again every 5 s for
as long as it takes, so a database that comes up later is picked up by itself.

The usual reasons:

| `cannot start:` says | What to do |
|---|---|
| `cannot reach Cassandra at 127.0.0.1 ... ECONNREFUSED` | The packages default to `GITCHA_STORE=cassandra` and no Cassandra answers. Set one up here with `sudo gitcha-setup-cassandra` (Gitcha starts by itself once it is up), point `GITCHA_CASSANDRA_CONTACT_POINTS` at your cluster, or set `GITCHA_STORE=file` in `/etc/inputloop/gitcha/gitcha.env` (`dpkg-reconfigure inputloop-gitcha` for the full packaging) and `systemctl restart gitcha` |
| `another Gitcha server (HOST, pid N) owns instance ...` | another server uses the same Cassandra instance: stop it or give this one its own `GITCHA_CASSANDRA_INSTANCE` |
| `... was written with a different secret key` | restore the `secret.key` that belongs to this database |
| `another process (pid N) is already using /var/lib/gitcha` | a second server (a hand-started `gitcha-server`) is running on the data directory |
| `could not listen on 127.0.0.1:4873 (EADDRINUSE)` | something else holds the port: `ss -ltnp | grep 4873` |
| a setting's name | the setting in `gitcha.env` is wrong; the message says what it expects |

If `gitcha-check` says Gitcha **is** running and answering, but the proxy still gets "connection
refused", the proxy is looking somewhere else: its upstream must be `http://127.0.0.1:4873` on the
same machine (`proxy_pass` in nginx), or the address in `GITCHA_HOST`/`GITCHA_PORT` if you changed them.
Run `gitcha-check` as root (it reads `gitcha.env`, then runs as the `gitcha` user, as the service does).

### The database: Cassandra or a file

`GITCHA_STORE` chooses. Either way the server holds the whole database in memory, serves every
read from there, and saves after every change before it answers; blobs, git repositories, sites,
logs and `secret.key` stay in `/var/lib/gitcha`.

- **`cassandra`** (the packages' default): rows in an Apache Cassandra keyspace. Each collection is
  split one row per entry (one user, one session, one package), and a save sends only the rows it
  changed, as one batch in one partition, which Cassandra applies whole or not at all. One table,
  `gitcha_db`, one partition per instance (`GITCHA_CASSANDRA_INSTANCE`), so many Gitcha servers can
  share a keyspace, one instance each. The keyspace and table are made at the first start
  (`GITCHA_CASSANDRA_REPLICATION`, `SimpleStrategy:1` by default; set
  `NetworkTopologyStrategy:dc1=3` for a real cluster, or `GITCHA_CASSANDRA_CREATE_KEYSPACE=no` and
  make it yourself). Reads and writes use `LOCAL_QUORUM` (`GITCHA_CASSANDRA_CONSISTENCY`).
- **`file`**: `/var/lib/gitcha/db.json`, written whole and synced on every change.

**Setting Cassandra up on the Gitcha machine.** The full packaging asks: when you choose
`cassandra` and none is installed, debconf offers to install one here
(`inputloop-gitcha/cassandra_setup`; preseed it `true` for unattended installs). Accept, and once the
apt run that installs Gitcha has ended, a one-off job adds Apache's apt repository
(`debian.cassandra.apache.org`, series `50x`) with Apache's signing key, installs and starts
`cassandra` (apt brings the Java it needs), waits until it answers on 9042, and restarts Gitcha:

```sh
journalctl -u gitcha-setup-cassandra -f      # follow it
```

It has to wait for the apt run because a package cannot install another while dpkg holds its lock.
The same command works by hand, for packages built with `build-debs.sh` (which ask nothing) or to try
again: `sudo gitcha-setup-cassandra` (`--series 41x` for Cassandra 4.1). It needs network access to
`apache.org` and about 4 GB of memory beside Gitcha; it changes none of Gitcha's settings, because
the defaults (`127.0.0.1`, `datacenter1`) are what one local node needs. For a cluster of several
nodes, install Cassandra yourself and answer debconf's questions about where its nodes are.

**Moving to Cassandra.** Point a server that has a `db.json` at an empty instance and start it: it
imports the file once and renames it `db.json.imported-to-cassandra`. Keep the same `secret.key`.

**One owner.** A server takes a lease row on its instance (60 s, renewed every 15 s), and every save
is a compare-and-set on that lease. A second server on the same instance waits up to 90 s for the
lease to lapse, then stops with `another Gitcha server (HOST, pid N) owns instance ...`; a lease left
by a dead process on the same machine is taken over at once. A server that loses its lease refuses
every change from then on and says so in its log; restart it.

**The key.** The instance remembers a check value of the `secret.key` that wrote it, so a server
started with another key stops (`... was written with a different secret key`) instead of
locking every account out.

**What it costs.** Each save waits for Cassandra (a few milliseconds on a local node; it was about
7 ms per change against Cassandra 5.0.9 here), during which that server answers nothing else, as it
waits for fsync with `db.json`. A save that takes longer than `GITCHA_CASSANDRA_TIMEOUT` (15 s) fails
and the change is undone. A change larger than 4 MB is sent as several batches, which are not atomic
together; only importing a big `db.json` comes near that. The whole instance is one partition, read
once at start: fine for the size of database one server holds in memory, and deletions (expired
sessions) leave tombstones in it until `gc_grace_seconds` (10 days) passes, so run `nodetool repair`
on the usual schedule.

### The reverse proxy: what it is for

Gitcha speaks plain HTTP only, on `127.0.0.1:4873`. It has no TLS code of its own, and its unit
gives it no capabilities, so it cannot open ports 80 or 443 either. A **reverse proxy** is the web
server that sits in front of it and does the parts of being on the internet that Gitcha leaves out:

- **TLS (https).** Passwords, two-factor codes, session cookies and device tokens cross the network
  encrypted. Over plain http anyone on the path can read them and act as the person.
- **Certificates.** The proxy holds a certificate for Gitcha's name, a wildcard for each hosting
  domain, and one for each verified custom domain. Caddy orders all of them by itself.
- **Ports 80 and 443,** with http redirected to https, so people type no port number.
- **The client's address,** passed on in `X-Forwarded-For`. Gitcha's rate limits and its
  new-network two-factor check need the address of the person, not of the proxy.

Gitcha needs five things from it, whichever proxy it is:

| The proxy must | Because |
|---|---|
| pass the **`Host` header** on unchanged | Gitcha tells its own UI from hosted sites and custom domains by `Host`, and the form check compares it with `GITCHA_PUBLIC_URL` |
| **replace** `X-Forwarded-For` with the client's address (or append it last) | Gitcha, with `GITCHA_TRUST_PROXY=true`, believes only the entry the nearest proxy added; a proxy that passes the client's own header through lets anyone pick their address |
| set **`X-Forwarded-Proto: https`** | with it Gitcha marks its cookies `Secure` (so does an `https://` public URL) |
| accept request bodies of **at least 150 MB** | a site deploy is base64 inside JSON: the 100 MiB `GITCHA_MAX_SITE_BYTES` is about 140 MB on the wire. nginx's own limit is 1 MB |
| wait **at least 120 s** for an answer | runners hold a request open up to 30 s waiting for a job, and big clones and deploys take longer than the usual 60 s |

and send every name to Gitcha: its own, each hosting domain's wildcard, and custom domains (any
other name), all to `127.0.0.1:4873`. Then set, in `gitcha.env`:

```sh
GITCHA_PUBLIC_URL=https://gitcha.example.org
GITCHA_TRUST_PROXY=true
GITCHA_TRUSTED_PROXIES=1      # one proxy; 2 if a CDN or load balancer stands before it, or their addresses
```

The examples, in `/usr/share/doc/inputloop-gitcha/` (and `deploy/` in the source), are ready to edit;
each was run in front of Gitcha with a forged `X-Forwarded-For` and a 150 MB upload:

| Proxy | File | Certificates | Custom domains |
|---|---|---|---|
| **Caddy** (recommended) | `Caddyfile.example` | ordered and renewed by Caddy | automatic: Caddy asks Gitcha first (on-demand TLS) |
| **nginx** | `nginx-gitcha.conf.example` | certbot | one `certbot` run per domain; nginx picks the file by name (its worker must be able to read the keys: the file says how) |
| **Apache httpd** | `apache-gitcha.conf.example` | certbot, or mod_md | a VirtualHost (or mod_md `MDomain`) per domain |
| **HAProxy** | `haproxy-gitcha.cfg.example` | certbot, one `.pem` per name in a folder | one `certbot` run per domain; HAProxy picks the `.pem` by name |

The smallest working setups, for the UI alone:

```caddy
gitcha.example.org {
	reverse_proxy 127.0.0.1:4873
}
```

```nginx
server {
    listen 443 ssl;
    server_name gitcha.example.org;
    ssl_certificate     /etc/letsencrypt/live/gitcha.example.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/gitcha.example.org/privkey.pem;
    client_max_body_size 200m;
    proxy_request_buffering off;
    proxy_read_timeout 120s;
    location / {
        proxy_pass http://127.0.0.1:4873;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```apache
<VirtualHost *:443>
    ServerName gitcha.example.org
    SSLEngine on
    SSLCertificateFile    /etc/letsencrypt/live/gitcha.example.org/fullchain.pem
    SSLCertificateKeyFile /etc/letsencrypt/live/gitcha.example.org/privkey.pem
    ProxyPreserveHost On
    ProxyPass        / http://127.0.0.1:4873/ timeout=120
    ProxyPassReverse / http://127.0.0.1:4873/
    RequestHeader set X-Forwarded-Proto "https"
    LimitRequestBody 209715200
</VirtualHost>
```

```haproxy
frontend gitcha_www
    bind :443 ssl crt /etc/haproxy/certs/
    http-request del-header X-Forwarded-For
    option forwardfor
    http-request set-header X-Forwarded-Proto https
    timeout client 120s
    default_backend gitcha
backend gitcha
    timeout server 120s
    server gitcha 127.0.0.1:4873
```

Apache appends the client's address to the `X-Forwarded-For` it was sent instead of replacing it;
that is safe, because Gitcha reads only the last entry. Check a setup with `curl -H
'X-Forwarded-For: 6.6.6.6' https://gitcha.example.org/register -D -`: the `Set-Cookie` line must say
`Secure`, and a failed sign-in afterwards must show your real address in the security log, not
6.6.6.6.

Git over SSH does not go through the proxy at all: sshd on port 22 hands it to Gitcha directly (see
"Git over SSH").

### Running without a reverse proxy

Gitcha runs without one: everything works over plain http, the web UI, the API, the CLI, the Claude
extension, git over HTTP, runners and hosted sites. What you lose is the encryption, the
certificates and ports 80/443. So it is fine where nobody untrusted can see the traffic, and **not
on the open internet**: there, every password, two-factor code and session cookie crosses in the
clear, and a session cookie or device token read off the wire is as good as the account (a
two-factor code cannot be replayed, but the session it opened can).

**On your own machine** (trying it out, developing): nothing to set. `npm start` (or the package
with the defaults) listens on `127.0.0.1:4873`; open `http://localhost:4873`.

**On a network you trust** (a home or office LAN, or a VPN such as WireGuard or Tailscale):

```sh
GITCHA_HOST=0.0.0.0                       # or only the LAN/VPN address, e.g. 10.8.0.1
GITCHA_PORT=4873                          # not 80: the unit gives Gitcha no right to ports under 1024
GITCHA_PUBLIC_URL=http://gitcha.lan:4873  # exactly what people type, port included
GITCHA_TRUST_PROXY=false                  # gitcha.env ships true, for a proxy: turn it off
```

then open port 4873 to that network only (`ufw allow from 192.168.1.0/24 to any port 4873`).
`GITCHA_TRUST_PROXY=false` matters: with it left on and no proxy, anyone can put any address in
`X-Forwarded-For` and walk past the rate limits. The start-up lines say which it is
(`client address  the socket (X-Forwarded-For ignored ...)`). Cookies are not marked `Secure`,
because the public URL is http. Clients take the same URL: `gitcha login --server
http://gitcha.lan:4873`, `gitcha-runner register --server http://gitcha.lan:4873 ...`, and git
remotes `http://gitcha.lan:4873/git/OWNER/REPO.git`. Hosted sites work too, with the port in the
address (`http://mysite.pages.lan:4873`), if your DNS or `/etc/hosts` points the hosting domain's
names at the server; custom domains get no certificates, so only http.
With Docker, publish the port to the network: change `127.0.0.1:4873:4873` in
`docker-compose.yml` to `4873:4873` (and set the environment above).

**For one person, from anywhere:** leave Gitcha on loopback and tunnel to it over SSH:

```sh
ssh -N -L 4873:127.0.0.1:4873 you@gitcha-host
```

and use `http://localhost:4873` on your own machine (set `GITCHA_PUBLIC_URL=http://localhost:4873`).
SSH encrypts the traffic, and nothing new is open on the server.

To move from one of these to a proxy later, put the proxy in front, set `GITCHA_PUBLIC_URL` to the
https address and `GITCHA_TRUST_PROXY=true`, and go back to `GITCHA_HOST=127.0.0.1`. Accounts and data
stay as they are; people sign in again, because their cookies were for the old address.

### TLS and DNS

With Caddy (`Caddyfile.example`), each hosting domain gets a wildcard certificate, and every
other name gets an on-demand one. Caddy asks `GET /api/v1/hosting/tls-allowed?domain=NAME` before
ordering one, and Gitcha says yes only for its own name, custom domains whose DNS check passed and
still passes (Gitcha looks again every six hours and drops a domain after three misses in a row),
and, as a stopgap for instances without a wildcard certificate, a site's subdomain while its owner
has ordered fewer than ten new ones this week. With nginx, Apache or HAProxy, ask the same
question yourself before running certbot for a custom domain (the example files show the
command). A public CA caps how many certificates one registered domain may order per week, so use
the wildcard certificate (it needs the DNS challenge: a Caddy build with your DNS provider's
module, or certbot's `--dns-PROVIDER` plugin); an account may also hold at most 25 sites whatever
the billing setting.

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

With `GITCHA_STORE=cassandra`, back up the keyspace (`nodetool snapshot gitcha` on each node, or
your cluster's backup) **and** `/var/lib/gitcha` (repositories, sites, blobs, `secret.key`); the
rest of this section is about `db.json`.

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
2. `apt install ./inputloop-gitcha-runner_*.deb`. The full packaging can do steps 3 and 4 for
   you: give debconf the server URL and a registration token (or put them in the preseed file).
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
  `GITCHA_PLANS_FILE`. A numeric `price` is shown per month in `GITCHA_CURRENCY` (USD by default),
  text as written; what is charged is whatever the Stripe Price or PayPal Plan says.
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
- Cancelling in Gitcha stops renewal and keeps the plan to the end of the period already paid for
  (Stripe is told `cancel_at_period_end`; PayPal can only cancel at once, so Gitcha holds the plan
  itself). `GET /api/v1/billing` shows the date as `subscription.endsAt`. An account whose last
  payment failed has no paid period left and ends at once.
- Every change to an account is written to the audit log of each owner of that account (and of the
  member who acted), saying who or what made it: the member (with the network address), the return
  page, a webhook (with the provider's event id) or the refresh. Owners see the last 25 in
  `GET /api/v1/billing` as `history`; plain team members do not.
- The Free limits are one allowance for a person's own account and the teams they created (a paid team
  has its own). When a paid plan ends, the newest sites over the Free limit stay served but are refused
  new deploys fourteen days after the paid period and its grace ended; an account that never paid is
  not locked, it just cannot add more. `GET /api/v1/billing` lists them as `overQuota`.
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
