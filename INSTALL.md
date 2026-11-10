<!-- SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> -->
<!-- SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st> -->
<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->
# Installing Gitcha: on your own computer, on a VPS, and on HostGator

This guide takes you from nothing to a running Gitcha, three ways:

1. **[On your own computer](#part-1-on-your-own-computer-to-try-it-and-test-it)**, to try it and test
   changes. About ten minutes.
2. **[On a HostGator VPS running Ubuntu](#part-2-a-hostgator-vps-with-ubuntu-2204-recommended)**, the
   recommended way to put it on the internet. About an hour, most of it waiting for DNS.
3. **[On a HostGator VPS running AlmaLinux, with or without cPanel](#part-3-a-hostgator-vps-with-almalinux-9-with-or-without-cpanel)**,
   if your VPS already has HostGator's default system.

Part 2 works on any Ubuntu 22.04 or 24.04 server, not only HostGator's. [DEPLOY.md](DEPLOY.md) is
the full reference (databases, runners, hosting, billing, the ring); this guide is the shortest safe
path through it.

**What was tested, and what was not.** Every command marked *rehearsed* was run on 2026-11-01 in a
fresh `ubuntu:22.04` or `almalinux:9` container, from this repository, ending with Gitcha answering
`/api/v1/health` and serving the sign-up page. Nothing here has been run on a real HostGator VPS, and
the steps that need a real one (DNS, certificates, the firewall, systemd, cPanel) are written from
the tools' own documentation and say so. If a step fails for you, `sudo gitcha-check` (Part 2) or
`journalctl -u gitcha -e` usually says why; the [troubleshooting table](#troubleshooting) lists the
usual reasons.

---

## Which HostGator plan works

Gitcha is a program that runs all the time (a Node.js server) and keeps its data on the server's
disk. That decides the plan:

| HostGator plan | Works? | Why |
|---|---|---|
| Shared hosting (Hatchling, Baby, Business) | **No** | No long-running programs, no Node.js, no root access |
| Cloud hosting | **No** | The same as shared hosting |
| Reseller hosting | **No** | The same as shared hosting |
| WordPress hosting | **No** | Only WordPress |
| **VPS hosting** | **Yes** | You get root over SSH and can install anything |
| **Dedicated server** | **Yes** | The same as a VPS, with a whole machine |

When you order the VPS:

- **Pick Ubuntu 22.04 if it is offered.** HostGator's default is AlmaLinux 9; Ubuntu is offered on
  its newer (NVMe) VPS plans. Ubuntu lets you use Gitcha's ready-made packages (Part 2). AlmaLinux
  works too, from source (Part 3).
- **You do not need cPanel.** Gitcha has its own web interface. cPanel takes ports 80 and 443 for
  its own Apache, which makes the setup longer (Part 3 covers it if you already have it).
- **Memory: 2 GB or more.** Gitcha keeps its database in memory and runs `git` for every clone and
  push. The service is capped at 2 GB by default.
- **Write down** the VPS's IP address and its root password (or add your SSH key) from HostGator's
  welcome email or the Customer Portal.

---

## Part 1: on your own computer, to try it and test it

This is the quickest way to see Gitcha working, and the way to test changes before you put them on
a server. Nothing here is reachable from the internet.

### What you need

- **Node.js 20 or newer** (22 is what the project uses). Check with `node -v`.
- **git**. Check with `git --version`.
- **An authenticator app** on your phone (Google Authenticator, Aegis, 1Password, Authy...). Every
  Gitcha account has two-factor sign-in, even on your own computer.

How to get Node.js and git:

- **Linux (Ubuntu or Debian):** follow the NodeSource steps in [Part 2, step 3](#step-3-install-nodejs-22),
  then `sudo apt-get install -y git`. Your distribution's own `nodejs` is usually too old.
- **macOS:** install [Homebrew](https://brew.sh), then:

  ```bash
  brew install node@22 git
  ```

  (Or use the installer from <https://nodejs.org>.)
- **Windows, directly:** install Node.js 22 (the LTS installer from <https://nodejs.org>) and
  [Git for Windows](https://git-scm.com/download/win), then use Command Prompt or PowerShell.
  `npm install`, `npm start` and the CLI have been run this way. Two things to know:
  - **Keep the code on an NTFS drive** (C: usually is). npm links Gitcha's parts together, and an
    exFAT or FAT32 drive (most USB sticks and many external drives) cannot hold those links:
    `npm install` then fails with `EISDIR: illegal operation on a directory, symlink`.
  - Cloning from and pushing to a Gitcha that itself runs on Windows has not been tried yet.
- **Windows, with WSL2** (the Linux that comes with Windows): the most tested way, since Gitcha is
  built and tested on Linux. In PowerShell, as administrator:

  ```powershell
  wsl --install -d Ubuntu-22.04
  ```

  Then follow the Linux steps inside Ubuntu, and keep the code in its home folder (`~/gitcha`), not
  under `/mnt/c`. Pages you open in your Windows browser at `http://localhost:4873` reach the server
  inside WSL2.

### Run it (rehearsed)

```bash
git clone https://github.com/inputloop/gitcha.git
```

```bash
cd gitcha
```

```bash
npm install
```

```bash
npm start
```

The repository is private to INPUTLOOP: `git clone` asks you to sign in to GitHub. Use your GitHub
username and a [personal access token](https://github.com/settings/tokens) as the password, or
clone with SSH (`git clone git@github.com:inputloop/gitcha.git`) if your SSH key is on GitHub.

When it prints `listening on http://127.0.0.1:4873`:

1. Open <http://localhost:4873> and choose **Register**.
2. Pick a username and password, scan the QR code with your authenticator app, and type the
   6-digit code it shows. **The first account becomes the administrator.**
3. You are in. Stop the server with **Ctrl+C** in its terminal; start it again with `npm start`.

### Where it keeps things

Everything (the database, repositories, sites, uploaded files and the encryption key) is in
`server/gitcha-data/`. To start over with no accounts, stop the server and delete that folder.
To keep it somewhere else:

```bash
GITCHA_DATA_DIR=$HOME/gitcha-test npm start
```

Other useful settings while testing (each goes before `npm start` the same way):

| Setting | What it does |
|---|---|
| `GITCHA_PORT=5000` | Use another port, if 4873 is taken |
| `GITCHA_OPEN_REGISTRATION=false` | Only the first account may register |
| `GITCHA_PUBLIC_READ=true` | Public repositories and packages can be read without signing in |

Every setting is listed, with its default, in [`deploy/gitcha.env`](deploy/gitcha.env).

### The command-line tool

In a second terminal, in the same `gitcha` folder:

```bash
node extension/bin/gitcha.js login
```

It asks for your password and an authenticator code, then remembers the sign-in. To type `gitcha`
instead of `node extension/bin/gitcha.js`:

```bash
npm link --workspace extension
```

Then `gitcha whoami`, `gitcha messages list`, `gitcha --help`.

### Connect Claude

Open <http://localhost:4873/claude> (*Connect Claude* in the page footer). It fills in where Gitcha's
code is (when you are signed in on this same computer) and writes the Claude Desktop config and the
Claude Code command for you, with Copy buttons; pick your existing `claude_desktop_config.json` and it
adds Gitcha to it, keeping your other settings. The README's
[Installing the Claude extension](README.md#installing-the-claude-extension) has the same steps by hand.

### From your other computers and phone, anywhere: WireGuard

The README's [Reaching your Gitcha over WireGuard](README.md#reaching-your-gitcha-over-wireguard) sets
up an encrypted private network to this computer, with Gitcha, the CLI and Claude working on your
laptop as if Gitcha ran there.

### Try it from your phone on the same Wi-Fi

Your phone cannot reach `localhost` on your computer, so let Gitcha listen on your network and tell
it the address phones use. Find your computer's address (`ip addr` on Linux, System Settings >
Network on a Mac, `ipconfig` on Windows; something like `192.168.1.20`), then:

```bash
GITCHA_HOST=0.0.0.0 GITCHA_PUBLIC_URL=http://192.168.1.20:4873 GITCHA_TRUST_PROXY=false npm start
```

and open `http://192.168.1.20:4873` on the phone. Two things to know:

- Your computer's firewall may need to allow port 4873 from your network.
- **Encrypted messages do not work over plain http** except at `localhost`: browsers keep the
  encryption they use (Web Crypto) for https pages. The Messages page says so. Everything else
  works. To test Messages on a phone, use the VPS (Part 2), which has https.

Only do this on a network you trust: without https, anyone on the network can read what is sent.

### Run the tests

```bash
npm test --workspaces
```

That runs every part's tests (about 450 of them, a few minutes). `npm run check:responsive` checks
that every page fits phone and desktop screens (it needs the Chromium that Playwright uses).

### Rehearse the server install on your own computer

Before you rent a VPS, you can run the whole of Part 2 in a throwaway Ubuntu virtual machine on your
own computer. [Multipass](https://multipass.run) makes one in a minute on Linux, macOS or Windows:

```bash
multipass launch 22.04 --name gitcha-test --memory 2G --disk 10G
```

```bash
multipass shell gitcha-test
```

Inside it, follow Part 2 from [step 3](#step-3-install-nodejs-22), answer the first install
question with `http://localhost:4873`, skip the DNS, Caddy and firewall steps, and check it with
`curl http://127.0.0.1:4873/api/v1/health`. Delete it afterwards with
`multipass delete --purge gitcha-test`.

### Or with Docker

If you use Docker, this builds Gitcha's image without the Cassandra database and runs it with one
data file:

```bash
docker build --build-arg GITCHA_WITH_CASSANDRA=no -t gitcha .
```

```bash
docker run -d --name gitcha -p 127.0.0.1:4873:4873 -e GITCHA_STORE=file -e GITCHA_PUBLIC_URL=http://localhost:4873 -v gitcha-data:/data gitcha
```

`docker compose up -d` instead runs it with an Apache Cassandra database beside it, which wants 2 GB
of memory of its own. (The Docker image could not be built in the session that wrote this guide,
whose network blocks Alpine's package mirrors; it is the same image `docker compose` builds.)

---

## Part 2: a HostGator VPS with Ubuntu 22.04 (recommended)

In this part you will:

1. point your domain at the VPS;
2. sign in to the VPS and prepare it (updates, clock, firewall);
3. install Node.js 22;
4. build Gitcha's Debian package on the VPS;
5. install it, answering three questions;
6. put **Caddy** in front of it for https;
7. make the administrator account, and close sign-up if you want to.

Throughout, replace **`gitcha.example.com`** with your own name and **`203.0.113.10`** with your
VPS's IP address.

### Step 1: point your domain at the VPS

Gitcha needs a name, such as `gitcha.example.com`, so that a certificate can be issued for it.

Add an **A record** (an address record) for that name with the VPS's IP address:

| Type | Name | Points to | TTL |
|---|---|---|---|
| A | `gitcha` (for `gitcha.example.com`) | `203.0.113.10` | 1 hour (or the default) |

Where you add it depends on who runs your domain's DNS:

- **The domain is at HostGator:** the Customer Portal's **Domains** section, then the domain's
  **DNS** settings (or cPanel's **Zone Editor** on a cPanel plan).
- **Somewhere else** (Cloudflare, Namecheap, GoDaddy...): that company's DNS page. If you use
  Cloudflare, set the record to **DNS only** (the grey cloud) at first, so Caddy can get its
  certificate directly.

It can take from a few minutes to a few hours to work everywhere. Check it from your own computer:

```bash
nslookup gitcha.example.com
```

It is ready when the answer shows your VPS's IP address. Carry on with steps 2 to 5 while you wait.

### Step 2: sign in and prepare the VPS

From your computer's terminal (on Windows, PowerShell or WSL2):

```bash
ssh root@203.0.113.10
```

Use the root password from HostGator's welcome email the first time. Everything below is typed on
the VPS.

**Bring the system up to date:**

```bash
apt-get update && apt-get -y upgrade
```

**Set the clock right.** Two-factor codes are based on the time; a clock that is off by more than a
minute makes every code look wrong.

```bash
timedatectl set-ntp true
```

```bash
timedatectl
```

It should say `System clock synchronized: yes` (give it a minute).

**Turn on the firewall**, letting in only SSH and the web:

```bash
ufw allow OpenSSH
```

```bash
ufw allow 80/tcp
```

```bash
ufw allow 443/tcp
```

```bash
ufw enable
```

Answer `y`. Port 4873, where Gitcha itself listens, stays closed: only Caddy on the same machine
talks to it. (If `ufw` is not installed: `apt-get install -y ufw`. Allow OpenSSH *before* enabling
it, or you lock yourself out.)

**Optional but wise:** sign in with an SSH key instead of the root password, and then turn password
sign-in off (`PasswordAuthentication no` in `/etc/ssh/sshd_config`, then `systemctl reload ssh`).
Test the key in a second window before you close the first.

### Step 3: install Node.js 22

Ubuntu 22.04's own Node.js is version 12, far too old; Gitcha's package needs 20 or newer, so it
comes from **NodeSource**, the usual source of current Node.js for Ubuntu:

```bash
apt-get install -y ca-certificates curl gnupg git
```

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
```

```bash
bash /tmp/nodesource_setup.sh
```

```bash
apt-get install -y nodejs
```

Check: `node -v` should print `v22.` something, and `npm -v` a version number.

(*Rehearsed* with Node 22 from nodejs.org instead, because the rehearsal's network blocked
NodeSource; the build only needs `node` and `npm` 20 or newer, whichever way they came.)

### Step 4: build the Gitcha package (rehearsed)

The tools that build Debian packages:

```bash
apt-get install -y debhelper devscripts dpkg-dev fakeroot
```

Get the code. The repository is private, so `git clone` asks for your GitHub username and a
[personal access token](https://github.com/settings/tokens) (with read access to
`inputloop/gitcha`) as the password:

```bash
git clone https://github.com/inputloop/gitcha.git /opt/gitcha-src
```

Build it, without the Cassandra database (one data file is right for one server):

```bash
cd /opt/gitcha-src && sh deploy/build-debian.sh /opt/gitcha-build --without-cassandra
```

It downloads the server's libraries from the npm registry and takes a few minutes. It ends by
listing the packages it made in `/opt/gitcha-build/`:

- `inputloop-gitcha_...deb`, **the server: the one you install now**;
- `inputloop-gitcha-runner_...deb`, `inputloop-gitcha-medic_...deb` and
  `inputloop-gitcha-omni-gateway_...deb`, optional extras covered in DEPLOY.md.

(Don't want build tools on your server? Run step 4 on any other Ubuntu or Debian machine, or in the
Multipass VM from Part 1, and copy the `.deb` over with
`scp inputloop-gitcha_*.deb root@203.0.113.10:/root/`. You still need step 3 on the server.)

### Step 5: install it (rehearsed)

```bash
cd /opt/gitcha-build && apt-get install -y ./inputloop-gitcha_*_all.deb
```

The `./` matters: it tells apt to install this file, not look for a package of that name. It asks
three questions:

| Question | Answer |
|---|---|
| Public URL of this Gitcha server | `https://gitcha.example.com` (with `https://`) |
| Domains that hosted sites get subdomains on | Leave it **empty** for now (see [Hosted sites](#hosted-sites-later)) |
| Enable and start the gitcha service now? | **Yes** |

If you answer one wrong, ask the questions again with `dpkg-reconfigure inputloop-gitcha`.

Check that it is running:

```bash
systemctl status gitcha --no-pager
```

```bash
curl -s http://127.0.0.1:4873/api/v1/health
```

The second should print a line starting `{"ok":true,"service":"gitcha"`. If it does not,
`gitcha-check` says why (see [Troubleshooting](#troubleshooting)).

What the package set up:

| Where | What |
|---|---|
| `/usr/bin/gitcha-server` | The server, run by the `gitcha` service as the `gitcha` user |
| `/etc/inputloop/gitcha/gitcha.env` | Every setting, with comments. Edit this, then `systemctl restart gitcha` |
| `/etc/inputloop/gitcha/debconf.env` | Your three answers (read after `gitcha.env`, so they win) |
| `/var/lib/gitcha/` | All data: `db.json`, repositories, sites, uploads, and **`secret.key`** |
| `/usr/share/doc/inputloop-gitcha/` | Example proxy configurations (Caddy, nginx, Apache, HAProxy) |

The package already sets `GITCHA_TRUST_PROXY=true`, which is right once Caddy is in front (step 6):
Gitcha then reads the visitor's real address from Caddy for its rate limits and new-network checks.

### Step 6: https with Caddy

Gitcha speaks plain http on `127.0.0.1:4873` only. **Caddy** is a web server that sits in front of
it on ports 80 and 443, gets a free certificate from Let's Encrypt by itself, renews it, and sends
every request on to Gitcha. It already does everything Gitcha needs from a proxy.

Install it from Caddy's own repository (Caddy's documented steps for Ubuntu):

```bash
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
```

```bash
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
```

```bash
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
```

```bash
apt-get update && apt-get install -y caddy
```

Now tell it about Gitcha. Replace the whole of `/etc/caddy/Caddyfile` with these lines (using your
own name):

```bash
cat > /etc/caddy/Caddyfile <<'EOF'
gitcha.example.com {
	reverse_proxy 127.0.0.1:4873
}
EOF
```

```bash
systemctl reload caddy
```

Within a minute (once the DNS from step 1 works), <https://gitcha.example.com> shows Gitcha with a
padlock. If it does not, `journalctl -u caddy -e` says what Caddy is waiting for; usually DNS that
has not reached Let's Encrypt yet, or a port the firewall still blocks.

(The full `Caddyfile.example` in `/usr/share/doc/inputloop-gitcha/` adds hosted sites and custom
domains; you do not need it to start.)

### Step 7: make the administrator account

1. Open `https://gitcha.example.com` and choose **Register**.
2. Pick a username and a long password, scan the QR code with your authenticator app and type the
   code. **The first account to register becomes the administrator**, so do this straight away.
3. Should strangers be able to sign up? If not, close registration:

   ```bash
   sed -i 's/^#\?GITCHA_OPEN_REGISTRATION=.*/GITCHA_OPEN_REGISTRATION=false/' /etc/inputloop/gitcha/gitcha.env
   ```

   ```bash
   systemctl restart gitcha
   ```

   With registration closed, nobody else can make an account, not even through you. To let someone
   join later, set it back to `true`, restart, let them register, and close it again.

From your own computer, sign the command-line tool in to the server (Part 1 shows how to get it):

```bash
gitcha login --server https://gitcha.example.com
```

You are done. The rest of Part 2 is what to do next week, not today.

### Back it up

Everything lives in `/var/lib/gitcha`. The most important file is **`/var/lib/gitcha/secret.key`**:
passwords and two-factor secrets in the database are encrypted with it, so **the database is
useless without the key that goes with it.** Keep a copy of the key somewhere safe and separate
(your password manager, an encrypted USB stick), and copy the data off the VPS regularly:

```bash
tar -czf /root/gitcha-$(date +%F).tgz -C /var/lib gitcha
```

Then, from your own computer:

```bash
scp root@203.0.113.10:/root/gitcha-*.tgz .
```

It is safe to copy while Gitcha runs: the database file is replaced in one step on every change.
Do not rely only on HostGator's own backups; check which ones your plan includes, and test a
restore. To restore: stop Gitcha (`systemctl stop gitcha`), put `/var/lib/gitcha` back (owned by
`gitcha`: `chown -R gitcha:gitcha /var/lib/gitcha`) **with its own `secret.key`**, and start it.

### Update it

```bash
cd /opt/gitcha-src && git pull
```

```bash
rm -rf /opt/gitcha-build && sh deploy/build-debian.sh /opt/gitcha-build --without-cassandra
```

```bash
apt-get install -y /opt/gitcha-build/inputloop-gitcha_*_all.deb
```

The package restarts Gitcha by itself, keeps your settings, and does not ask the questions again.
Back up first. Keep Ubuntu updated too: `apt-get update && apt-get -y upgrade` now and then (or turn
on `unattended-upgrades`).

### Hosted sites (later)

Gitcha can host static sites at `NAME.pages.example.net`. That needs:

- a **second domain** for the sites (not a subdomain of Gitcha's own; Gitcha refuses to start if
  they share one, so a site's scripts cannot reach Gitcha's cookies);
- a **wildcard DNS record** `*.pages.example.net` pointing at the VPS;
- a **wildcard certificate**, which Let's Encrypt only issues by proving control of the domain's
  DNS. Caddy can do that only with a module for your DNS company. HostGator's DNS has none, so the
  usual way is to move that domain's DNS to Cloudflare (free) and add the Cloudflare module to
  Caddy (`caddy add-package github.com/caddy-dns/cloudflare`);
- the domain in `GITCHA_HOSTING_DOMAINS` (`dpkg-reconfigure inputloop-gitcha`).

The commented `Caddyfile.example` and [DEPLOY.md's TLS and DNS section](DEPLOY.md#tls-and-dns) show
the rest. People who bring their own domain get a certificate each, on demand, with no more setup.

### Runners for CI pipelines (later)

CI jobs and lambda functions run on **runners**: separate machines that ask Gitcha for work. The
safe runner backend (bContain) gives each job its own small virtual machine, which needs hardware
virtualization (`/dev/kvm`). Check on the VPS:

```bash
ls -l /dev/kvm
```

A VPS usually does not have it ("No such file or directory"). Then run your runners somewhere that
does (a desktop, a home server, a dedicated server) and point them at
`https://gitcha.example.com`; [the Runners section of DEPLOY.md](DEPLOY.md#runners) says how.
Everything else in Gitcha works without a runner.

### Git over SSH (optional)

Git works over https with no more setup (`git clone https://gitcha.example.com/OWNER/REPO.git`).
Git over SSH uses a separate `git` account and an extra sshd setting; follow
[DEPLOY.md's Git over SSH](DEPLOY.md#git-over-ssh). That setup has not yet been tried against a real
sshd, so test it on a copy first.

---

## Part 3: a HostGator VPS with AlmaLinux 9, with or without cPanel

AlmaLinux is HostGator's default VPS system. Gitcha's ready-made packages are for Debian and Ubuntu,
so here you run it from source with a small systemd service. Do
[Part 2, steps 1 and 2](#step-1-point-your-domain-at-the-vps) first, with these AlmaLinux
differences:

- updates: `dnf -y upgrade`;
- clock: `timedatectl set-ntp true` (chrony does the work);
- firewall: `firewall-cmd --permanent --add-service=http --add-service=https && firewall-cmd --reload`
  (with cPanel, the firewall is often CSF in WHM instead; there ports 80 and 443 are already open).

### Step A: Node.js 22, git and gpg

```bash
dnf -y module enable nodejs:22
```

```bash
dnf -y install nodejs npm git gnupg2
```

`node -v` should print `v22.` something. If `dnf` says there is no `nodejs:22` stream
(`dnf module list nodejs` lists them), use 20, or NodeSource's repository for AlmaLinux:

```bash
curl -fsSL https://rpm.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh && bash /tmp/nodesource_setup.sh && dnf -y install nodejs
```

(*Not rehearsed:* the rehearsal's network blocked AlmaLinux's mirrors, so these two commands are
from the distributions' documentation. Everything from step B on was rehearsed on AlmaLinux 9.)

### Step B: the code, and a user to run it (rehearsed)

```bash
useradd --system --home-dir /var/lib/gitcha --shell /sbin/nologin gitcha
```

```bash
git clone https://github.com/inputloop/gitcha.git /opt/gitcha
```

```bash
cd /opt/gitcha && npm ci --omit=dev --omit=optional --workspace server
```

```bash
mkdir -p /etc/gitcha /var/lib/gitcha && chown gitcha:gitcha /var/lib/gitcha && chmod 700 /var/lib/gitcha
```

(`git clone` asks for your GitHub username and a personal access token, as in Part 2.
`--omit=optional` leaves out the Cassandra driver; one data file is right for one server.)

### Step C: the settings (rehearsed)

```bash
cp /opt/gitcha/deploy/gitcha.env /etc/gitcha/gitcha.env && chown root:gitcha /etc/gitcha/gitcha.env && chmod 640 /etc/gitcha/gitcha.env
```

Open `/etc/gitcha/gitcha.env` in an editor (`nano /etc/gitcha/gitcha.env`) and change two lines:

```sh
GITCHA_PUBLIC_URL=https://gitcha.example.com
GITCHA_STORE=file
```

Leave `GITCHA_HOST=127.0.0.1`, `GITCHA_PORT=4873` and `GITCHA_TRUST_PROXY=true` as they are.

### Step D: the service

Create `/etc/systemd/system/gitcha.service` with exactly this (it passed
`systemd-analyze verify`; it is a cut-down copy of the packaged unit):

```ini
[Unit]
Description=Gitcha (from source)
After=network.target
StartLimitIntervalSec=0

[Service]
User=gitcha
Group=gitcha
EnvironmentFile=/etc/gitcha/gitcha.env
Environment=GITCHA_DATA_DIR=/var/lib/gitcha
WorkingDirectory=/opt/gitcha
ExecStart=/usr/bin/node /opt/gitcha/server/src/index.js
Restart=on-failure
RestartSec=5s
StateDirectory=gitcha
StateDirectoryMode=0700
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/gitcha
MemoryMax=2G

[Install]
WantedBy=multi-user.target
```

(If `which node` prints something other than `/usr/bin/node`, use that path in `ExecStart`.)

```bash
systemctl daemon-reload && systemctl enable --now gitcha
```

```bash
curl -s http://127.0.0.1:4873/api/v1/health
```

It should print `{"ok":true,"service":"gitcha",...`. If not, `journalctl -u gitcha -e` shows what
it printed; a failed start always has a line beginning `gitcha: cannot start:`.

### Step E1: https without cPanel (Caddy)

```bash
dnf -y install 'dnf-command(copr)' && dnf -y copr enable @caddy/caddy && dnf -y install caddy
```

Then write `/etc/caddy/Caddyfile` and start it exactly as in
[Part 2, step 6](#step-6-https-with-caddy), with `systemctl enable --now caddy` in place of the
reload. If SELinux stops Caddy from reaching Gitcha (`journalctl -u caddy` shows "permission
denied" connecting to 127.0.0.1:4873), allow it with `setsebool -P httpd_can_network_connect 1`.

### Step E2: https with cPanel (its Apache)

With cPanel, Apache already owns ports 80 and 443, so you add Gitcha to it instead of installing
Caddy. *Not rehearsed:* this follows cPanel's documented way of adding settings to one domain's
virtual host; test it before you rely on it.

1. **Create the domain in cPanel.** In the cPanel account that should own it, add
   `gitcha.example.com` (under **Domains**). AutoSSL then gets it a certificate within a few hours;
   **SSL/TLS Status** shows when. Note the cPanel **username** of that account (below: `CPUSER`).
2. **Make sure Apache can proxy.** In WHM, **EasyApache 4** > **Customize** > **Apache Modules**:
   `mod_proxy`, `mod_proxy_http` and `mod_headers` must be on (they usually are).
3. **Send the https site to Gitcha.** As root:

   ```bash
   mkdir -p /etc/apache2/conf.d/userdata/ssl/2_4/CPUSER/gitcha.example.com
   ```

   Then create `/etc/apache2/conf.d/userdata/ssl/2_4/CPUSER/gitcha.example.com/gitcha.conf`:

   ```apache
   # Gitcha behind cPanel's Apache.  Certificate checks stay with Apache (AutoSSL); everything else goes to Gitcha.
   ProxyPreserveHost On
   ProxyPass        /.well-known/acme-challenge/ !
   ProxyPass        /.well-known/pki-validation/ !
   ProxyPass        / http://127.0.0.1:4873/ timeout=120
   ProxyPassReverse / http://127.0.0.1:4873/
   RequestHeader set X-Forwarded-Proto "https"
   LimitRequestBody 209715200
   ```

4. **Send plain http to https.** Create the same folder under `std` instead of `ssl`
   (`/etc/apache2/conf.d/userdata/std/2_4/CPUSER/gitcha.example.com/`) with a `gitcha.conf` of:

   ```apache
   RewriteEngine On
   RewriteCond %{REQUEST_URI} !^/\.well-known/
   RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [R=301,L]
   ```

5. **Rebuild Apache's configuration and restart it:**

   ```bash
   /usr/local/cpanel/scripts/rebuildhttpdconf && /usr/local/cpanel/scripts/restartsrv_httpd
   ```

What each line is for: Gitcha tells its own pages from hosted sites by the `Host` header
(`ProxyPreserveHost`); runners and big pushes take longer than Apache's default 60 s
(`timeout=120`); site uploads can be 150 MB (`LimitRequestBody`); and Gitcha marks its cookies
secure only when told the visitor used https (`X-Forwarded-Proto`). Apache adds the visitor's
address at the end of `X-Forwarded-For`, which is the entry Gitcha reads.

**If cPanel's NGINX caching is turned on** (WHM's "NGINX Manager", the `ea-nginx` package), there
are two proxies in front of Gitcha, not one; set `GITCHA_TRUSTED_PROXIES=2` in
`/etc/gitcha/gitcha.env` and restart Gitcha, or every visitor will look like they come from
127.0.0.1 (which makes the rate limits shared by everyone). Check by signing in: the
activity list on your **Account** page should show your own IP address, not 127.0.0.1.

Then make the administrator account as in [Part 2, step 7](#step-7-make-the-administrator-account)
(the settings file is `/etc/gitcha/gitcha.env` here), and back up `/var/lib/gitcha` the same way.

### Updating a from-source install

```bash
cd /opt/gitcha && git pull && npm ci --omit=dev --omit=optional --workspace server && systemctl restart gitcha
```

Check `deploy/gitcha.env` in the new code for new settings now and then; your
`/etc/gitcha/gitcha.env` is not changed by an update.

---

## Upgrading to a new version

A new version of Gitcha is new commits on the `main` branch of `inputloop/gitcha`. Upgrading means
fetching them, installing what they need, and restarting Gitcha. Your accounts, projects and settings
stay where they are: nothing below touches the data folder.

**Before every upgrade:**

1. **Back up the data folder** (and keep `secret.key` with it): `server/gitcha-data` on your own
   computer, `/var/lib/gitcha` on a server. See [Back it up](#back-it-up).
2. **See what you have and what is new.** In the code folder:

   ```bash
   git fetch origin
   ```

   ```bash
   git log --oneline HEAD..origin/main
   ```

   That lists the new commits (empty means you are up to date). The running server says its version
   at `/api/v1/health` (for example <http://localhost:4873/api/v1/health>).
3. **Read the notes.** README.md, INSTALL.md and `deploy/gitcha.env` say when something new needs a
   setting. Your own settings file is never changed by an upgrade, so a new setting stays at its
   default until you add it.

### On your own computer (Windows, macOS, Linux)

Stop Gitcha (Ctrl+C in its window), then in the code folder (`C:\gitcha\server\gitcha` or wherever
yours is):

```bash
git pull
```

```bash
npm install
```

```bash
npm start
```

`npm install` brings in any new libraries the update needs; run it every time, even when nothing
seems to have changed. Then:

- **The Claude extension** runs from the same folder, so it is upgraded too. Restart Claude Desktop
  (quit it from the tray) or start a new Claude Code session to load it.
- **If you installed the Claude Code plugin** with `/plugin marketplace add`, also run
  `/plugin marketplace update gitcha` in Claude Code.
- **If `git pull` refuses** because you changed files yourself, `git stash`, then `git pull`, then
  `git stash pop`.

### On an Ubuntu VPS (the package, Part 2)

The same as [Update it](#update-it) in Part 2:

```bash
cd /opt/gitcha-src && git pull
```

```bash
rm -rf /opt/gitcha-build && sh deploy/build-debian.sh /opt/gitcha-build --without-cassandra
```

```bash
apt-get install -y /opt/gitcha-build/inputloop-gitcha_*_all.deb
```

The package restarts Gitcha by itself. Check it came back:

```bash
curl -s http://127.0.0.1:4873/api/v1/health
```

The package's version names the commit it was built from (`0.2.0+git20261101...` and the commit's
first seven characters), so apt always sees a newer commit as newer. If apt says `is already the
newest version`, the pull brought nothing new.

### On AlmaLinux from source (Part 3)

```bash
cd /opt/gitcha && git pull && npm ci --omit=dev --omit=optional --workspace server && systemctl restart gitcha
```

Then check `/api/v1/health` as above.

### With Docker

```bash
git pull && docker compose build && docker compose up -d
```

The data is in the `gitcha-data` volume, which the new container uses as it is.

### If the new version will not start

`journalctl -u gitcha -e` on a server (or the window it runs in, on your own computer) shows a line
beginning `gitcha: cannot start:` with the reason. To go back to the version you had:

```bash
git log --oneline -5
```

```bash
git checkout COMMIT
```

using the commit you were on before the pull, then repeat the install step for your setup (`npm
install`, or the package build and `apt-get install`, or `npm ci`) and restart. If the new version
already ran, restore the backup you made first as well: a newer version may have saved the data in
a way the older one does not expect. `git checkout main` returns to the newest version later.

---

## Troubleshooting

Start here, on the server:

```bash
sudo gitcha-check
```

(Part 2's package only.) It tries what a start needs (the settings, the database, the port) and says
in plain words what is wrong. Then:

```bash
journalctl -u gitcha -e
```

shows everything Gitcha printed, and every failed start has one line beginning `gitcha: cannot start:`
with the reason.

| What you see | What it means | What to do |
|---|---|---|
| The browser says "502 Bad Gateway" or Caddy logs "connection refused" | Gitcha itself is not running | `systemctl status gitcha`, then `journalctl -u gitcha -e` |
| `cannot start: cannot reach Cassandra` | The package was built without `--without-cassandra` | Set `GITCHA_STORE=file` in `gitcha.env` and `systemctl restart gitcha` (or rebuild as in step 4) |
| `apt` says `nodejs (>= 20)` cannot be installed | Ubuntu's old Node.js is in the way | Do [step 3](#step-3-install-nodejs-22) first, then install again |
| Caddy logs about a certificate failing | DNS does not point here yet, or ports 80/443 are closed | `nslookup gitcha.example.com`; `ufw status` |
| Every two-factor code is "wrong" | The server's or the phone's clock is off | `timedatectl` (must say synchronized); check the phone's time is set automatically |
| `could not listen on 127.0.0.1:4873 (EADDRINUSE)` | Something else uses the port, often a second Gitcha you started by hand | `ss -ltnp \| grep 4873` |
| `another process (pid N) is already using /var/lib/gitcha` | Two Gitchas on one data folder | Stop the extra one; only the service should run |
| `... was written with a different secret key` | The data was restored without its own `secret.key` | Put back the `secret.key` that was saved with that data |
| `npm install` says `EISDIR: illegal operation on a directory, symlink` (Windows) | The code is on an exFAT or FAT32 drive, which cannot hold npm's links | Clone it onto an NTFS drive such as C:, or use WSL2 |
| Uploading a big site fails | The proxy limits request size | Caddy has no limit; with Apache, check `LimitRequestBody` (Part 3) |
| The Messages page says it needs https | You are on plain http at an address other than localhost | Use the https address, or `http://localhost:4873` |
| Everyone shares one rate limit; sign-in history shows 127.0.0.1 | Gitcha sees the proxy's address, not the visitor's | Part 3's note on `GITCHA_TRUSTED_PROXIES` |

More reasons, and what each means, are in [DEPLOY.md: When it does not start](DEPLOY.md#when-it-does-not-start).
For security settings to check before you invite people, read the README's
[Securing your deployment](README.md#securing-your-deployment).
