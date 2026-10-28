<p align="center">
  <img src="server/public/logo.svg" width="88" alt="Gitcha logo">
</p>

<h1 align="center">Gitcha</h1>

<p align="center">
  <strong>A free, self-hosted software package registry with mandatory two-factor authentication, and a Claude extension that speaks it.</strong>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: AGPL-3.0-or-later" src="https://img.shields.io/badge/license-AGPL--3.0--or--later-6a4cf5"></a>
  <img alt="Node 20+" src="https://img.shields.io/badge/node-%E2%89%A520-18c5a8">
  <img alt="2FA required" src="https://img.shields.io/badge/2FA-required-0f8a71">
  <img alt="Client dependencies: 0" src="https://img.shields.io/badge/client%20deps-0-3b4bc8">
</p>

![Gitcha landing page](docs/screenshots/01-landing.png)

Gitcha lets a team or community host its own packages: publish tarballs,
browse them on the web, and install them with integrity checking. Anyone can
start a **team**, invite people with owner, maintainer or member roles, and
share packages that the whole team maintains, optionally visible to team
members only. Every
account needs a password **and** an authenticator app (Google Authenticator,
Authy, Aegis, 1Password…) to sign in and to install for the first time. After
that, the registry asks for a fresh code from time to time. Each user can turn
those follow-up checks on or off; an administrator can lock any of them on.

The **Gitcha Claude extension** lets Claude search, install and publish
packages for you. It reuses the device you sign in with once from your
terminal, so **Claude never sees your password**. When the registry asks for
a 2FA check, Claude has to ask *you* for the code.

---

## Contents

- [Features](#features)
- [Quick start](#quick-start)
- [Walkthrough with screenshots](#walkthrough-with-screenshots)
  - [1. Create an account (2FA required)](#1-create-an-account-2fa-required)
  - [2. Sign in](#2-sign-in)
  - [3. First run of the CLI](#3-first-run-of-the-cli)
  - [4. Publish and install](#4-publish-and-install)
  - [5. Browse the registry](#5-browse-the-registry)
  - [6. Intermittent 2FA checks](#6-intermittent-2fa-checks)
  - [7. Toggle the follow-up checks](#7-toggle-the-follow-up-checks)
  - [8. Teams and shared packages](#8-teams-and-shared-packages)
  - [9. Use it from Claude](#9-use-it-from-claude)
- [Installing the Claude extension](#installing-the-claude-extension)
- [CLI reference](#cli-reference)
- [Package format](#package-format)
- [Server configuration](#server-configuration)
- [HTTP API](#http-api)
- [Security model](#security-model)
- [Project layout](#project-layout)
- [Development](#development)
- [License](#license)

---

## Features

**Registry server**

- 🔐 **Mandatory TOTP 2FA.** Enrollment with a QR code is part of sign-up; an
  account can't sign in until its authenticator is confirmed. Ten single-use
  recovery codes are shown once.
- ⏱ **Intermittent re-verification**, enforced by the server:
  - every 12 hours (configurable),
  - when a device shows up on a new network,
  - before sensitive actions (publish, yank, revoking devices).
- 🎚 **User-toggleable follow-up checks.** Sign-in always needs a code, but
  each user can switch the three follow-up checks on or off. Changing them
  needs a fresh code, and admins can lock checks on with
  `GITCHA_LOCKED_CHECKS`.
- 👥 **Teams.** Anyone can start a team and manage it. Owners manage members
  and roles, maintainers publish and yank the team's packages, and members can
  see team-only packages. Move personal packages into a team to share them, or
  publish straight into one.
- 🔒 **Secrets encrypted at rest.** Passwords are hashed with scrypt *and then*
  encrypted with AES-256-GCM. TOTP secrets are AES-256-GCM encrypted. Session
  and device tokens and recovery codes are stored only as hashes.
- 📦 **Integrity-pinned packages.** Tarballs are addressed by SHA-256,
  versions are immutable, and both server and client reject path traversal
  and links.
- 🧾 **Audit log**, a device list with one-click revoke, rate limiting, CSRF
  protection, a strict CSP, and private-by-default reads.
- 🪶 **Small.** Plain Node.js with a single dependency (`qrcode`) and a
  JSON-file store. Runs with `node`, Docker or docker-compose.

**Claude extension + CLI** (one zero-dependency package in `extension/`)

- A Claude Code plugin (MCP server, skill, slash commands and a
  session-start status hook), plus a Claude Desktop extension manifest.
- Twelve tools covering search, install, publish, yank, teams, sharing, 2FA
  checks and check settings (listed [below](#tools)).
- The `gitcha` CLI handles first-run sign-in, publish/install, teams,
  `verify`, `security` and `logout`.

---

## Quick start

Requires **Node.js 20+**.

```bash
git clone https://github.com/inputloop/gitcha.git
```

```bash
cd gitcha && npm install
```

```bash
npm start
```

Open <http://localhost:4873>, create an account and scan the QR code with your
authenticator app. The first account becomes the administrator.

Then, in another terminal, sign the CLI in (password + authenticator code):

```bash
node extension/bin/gitcha.js login
```

Tip: `npm link --workspace extension` puts `gitcha` and `gitcha-mcp` on your
`PATH`, so you can type `gitcha login`.

**With Docker:**

```bash
docker compose up -d
```

The data volume holds `db.json`, the package blobs and `secret.key`. See
[Server configuration](#server-configuration) before you expose it to the
internet.

---

## Walkthrough with screenshots

All screenshots come from a real server started by
[`scripts/screenshots.mjs`](scripts/screenshots.mjs). Terminal images show
real CLI output, and the Claude image shows real MCP tool calls and responses.
Regenerate them with `npm run screenshots`.

### 1. Create an account (2FA required)

Choose a username and password. Passwords must be at least 10 characters and
must not contain your username.

![Registration form](docs/screenshots/02-register.png)

Next, scan the QR code with Google Authenticator or any TOTP app. If you can't
scan it, type the key in manually. Enter the 6-digit code to activate the
account.

![Two-factor enrollment with QR code](docs/screenshots/03-setup-2fa.png)

Save your recovery codes. Each one works once if you lose your phone, and they
are never shown again (you can generate a new set from the Account page).

![Recovery codes](docs/screenshots/04-recovery-codes.png)

### 2. Sign in

Signing in always takes two steps: your password, then a code from your
authenticator app.

| Password | Authenticator code |
|---|---|
| ![Sign in](docs/screenshots/05-login.png) | ![Two-factor code](docs/screenshots/06-login-2fa.png) |

### 3. First run of the CLI

Nothing can be installed until this machine has signed in with a password and
a 2FA code. `gitcha login` saves a revocable **device token** with file
mode 600. It never saves your password. `gitcha status` shows when the next
periodic check is due.

![gitcha login and status](docs/screenshots/11-cli-login.png)

### 4. Publish and install

Publishing is a sensitive action: it needs a code no older than 10 minutes, and
the CLI prompts for one when needed. Installs are checked against the SHA-256
from the registry and recorded in `gitcha-lock.json`.

![Publishing and installing from the terminal](docs/screenshots/12-cli-publish-install.png)

### 5. Browse the registry

Browsing is private by default: only signed-in, 2FA-verified users can see
packages (set `GITCHA_PUBLIC_READ=true` to change that).

![Package list](docs/screenshots/07-packages.png)

Each package page shows its README, install command, license, versions and
integrity hashes.

![Package detail page](docs/screenshots/08-package.png)

### 6. Intermittent 2FA checks

When a check is due (for example after 12 hours, on a new network, or before
a sensitive action), the browser is sent to a short "Confirm it's you" step.
The CLI prompts for a code, and the Claude extension asks you for one.

![Step-up verification page](docs/screenshots/10-step-up.png)

### 7. Toggle the follow-up checks

The **Account** page lets you switch the follow-up checks on or off, see every
signed-in browser and device (and revoke them), regenerate recovery codes, and
read your security activity log. Changing a switch needs a fresh code. Checks
your administrator has locked show as "required by admin" and can't be turned
off.

![Account security page](docs/screenshots/09-account.png)

The same settings are available from the terminal:

![gitcha security](docs/screenshots/13-cli-security.png)

```bash
gitcha security --new-network off --interval on
```

### 8. Teams and shared packages

Open **Teams**, give the team a name, and you become its first owner. Teams
are listed with your role, member count and shared packages:

![Teams list](docs/screenshots/15-teams.png)

On the team page, owners add people by username and set roles. The page also
lists everything the team owns. Packages marked 🔒 **team only** are invisible
to anyone outside the team: they don't appear in search, and their names
can't be squatted.

![Team page with members, roles and shared packages](docs/screenshots/16-team.png)

| Role | Can |
|---|---|
| **owner** | Add and remove members, change roles, delete the (empty) team, plus everything below |
| **maintainer** | Publish new versions, yank versions, move packages into the team, change team-only visibility |
| **member** | See and install the team's team-only packages |

Teams always keep at least one owner. Members can leave on their own. Adding,
removing or re-roling members needs a fresh 2FA code (the sensitive-action
check), and every change appears in the audit log of both the owner and the
affected user.

There are three ways to share a package with a team:

- publish straight into it: `gitcha publish --team acme [--private]`, or put
  `"team": "acme"` (and optionally `"private": true`) in `gitcha.json`;
- move an existing package in: `gitcha transfer my-pkg acme`, or use **Share
  with a team** on the package page;
- change who can see it: `gitcha access my-pkg team-only|public`.

The same workflow from the terminal:

![Team commands in the CLI](docs/screenshots/17-cli-teams.png)

### 9. Use it from Claude

Once `gitcha login` has run, Claude can search, install and publish for you.
When the registry asks for a 2FA check, the tool result tells Claude to ask
you for the current code and never to invent one:

![Claude using the Gitcha extension, including a 2FA check](docs/screenshots/14-claude-extension.png)

---

## Installing the Claude extension

The extension lives in [`extension/`](extension). It has no dependencies and
contains the MCP server, the CLI, and the plugin/extension manifests.

### Step 1: sign in once (required for every option)

```bash
node extension/bin/gitcha.js login --server https://packages.example.org
```

You'll be asked for your username, password (hidden) and authenticator code.
Claude never handles this step.

### Option A: Claude Code plugin (recommended)

The repository is also a plugin marketplace (see
[`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json)). In
Claude Code:

```
/plugin marketplace add inputloop/gitcha
/plugin install gitcha@gitcha
```

Set `GITCHA_SERVER` in your environment if your registry isn't on
`localhost:4873` (the plugin's `.mcp.json` passes it through). The plugin adds:

| Piece | What it does |
|---|---|
| MCP server `gitcha` | The eight `gitcha_*` tools |
| Skill `gitcha` | Teaches Claude the first-run and 2FA rules |
| `/gitcha:gitcha-status` | Shows sign-in and 2FA status |
| `/gitcha:gitcha-publish [dir]` | Guided, confirmed publish |
| SessionStart hook | Tells Claude whether Gitcha is signed in and when the next 2FA check is due |

### Option B: add only the MCP server to Claude Code

```bash
claude mcp add gitcha --env GITCHA_SERVER=https://packages.example.org -- node /path/to/gitcha/extension/bin/gitcha-mcp.js
```

### Option C: Claude Desktop

[`extension/manifest.json`](extension/manifest.json) is a Claude Desktop
extension manifest (MCPB). Pack it with the MCPB tool and open the resulting
file in Claude Desktop. It asks for your registry URL.

```bash
npx @anthropic-ai/mcpb pack extension
```

Or add the server to `claude_desktop_config.json` by hand:

```json
{
  "mcpServers": {
    "gitcha": {
      "command": "node",
      "args": ["/path/to/gitcha/extension/bin/gitcha-mcp.js"],
      "env": { "GITCHA_SERVER": "https://packages.example.org" }
    }
  }
}
```

### Tools

| Tool | Purpose | 2FA |
|---|---|---|
| `gitcha_status` | Who is signed in and when the next check is due | Login only |
| `gitcha_search` | Search packages | Periodic / new-network checks |
| `gitcha_package_info` | Versions, integrity, README | Periodic / new-network checks |
| `gitcha_install` | Download, verify, extract and lock (or install all from `gitcha.json`) | Periodic / new-network checks |
| `gitcha_publish` | Pack and publish a directory | **Fresh code** (sensitive) |
| `gitcha_yank` | Yank or restore a version | **Fresh code** (sensitive) |
| `gitcha_teams` | List your teams, or show a team's members and shared packages | Periodic / new-network checks |
| `gitcha_team_create` | Start a team (you become owner) | Periodic / new-network checks |
| `gitcha_team_member` | Add, re-role or remove a member, or leave | **Fresh code** (sensitive) |
| `gitcha_share_package` | Move a package into a team and/or make it team-only | **Fresh code** (sensitive) |
| `gitcha_verify_2fa` | Complete a check with a code the user typed | n/a |
| `gitcha_security_settings` | View or toggle follow-up checks | **Fresh code** to change |

If the extension runs before `gitcha login`, every tool refuses and tells
Claude to have you run the login command yourself, and not to ask for your
password.

---

## CLI reference

```text
gitcha login [--server URL] [--device NAME]   sign in with password + authenticator code
gitcha status                                 who you are and when the next 2FA check is due
gitcha verify [CODE]                          re-confirm 2FA now
gitcha security [--interval on|off] [--new-network on|off] [--sensitive on|off]
gitcha search [query]
gitcha info <name>
gitcha install [name[@version]] [--dir DIR]   one package, or everything in gitcha.json
gitcha publish [DIR] [--team T] [--private]
gitcha yank <name@version> [--undo]
gitcha transfer <name> <team>                 move a package into a team to share it
gitcha access <name> team-only|public
gitcha team list
gitcha team create <name> [--description D]
gitcha team info <name>
gitcha team add <team> <user> [--role member|maintainer|owner]
gitcha team remove <team> <user>              remove a member, or yourself to leave
gitcha team delete <name>
gitcha logout                                 revoke this device's token
gitcha mcp                                    run the Claude extension on stdio
```

Global options: `--server URL` (or `GITCHA_SERVER`), `--json`. Credentials are
stored in `$GITCHA_CONFIG_DIR`, `$XDG_CONFIG_HOME/gitcha`, `~/.config/gitcha`
or `%APPDATA%\gitcha`.

When a periodic or sensitive-action check is due in an interactive terminal,
the CLI asks for a code and retries automatically. In scripts it exits with a
message telling you to run `gitcha verify`.

---

## Package format

A package is any directory with a `gitcha.json`:

```json
{
  "name": "tiny-logger",
  "version": "2.1.0",
  "description": "Leveled, timestamped console logging.",
  "license": "GPL-3.0-or-later",
  "homepage": "https://example.org/tiny-logger",
  "files": ["src/"],
  "team": "acme",
  "private": false,
  "dependencies": { "color-utils": "^0.3.2" }
}
```

- `name`: lowercase letters, digits, `.`, `_`, `-` (max 64). The first person
  (or team) to publish a name owns it.
- `team` (optional): publish a new package owned by this team (you must be a
  maintainer or owner of it).
- `private` (optional, team packages only): `true` makes it visible to team
  members only.
- `version`: semantic version. Published versions are immutable; yank a bad
  one instead of overwriting it.
- `files` (optional): globs to include. `gitcha.json`, README and LICENSE are
  always included.
- `.gitchaignore` (optional): globs to exclude. `.git`, `node_modules`,
  `gitcha_modules`, `.env*`, `*.pem`, SSH keys and `*.tgz` are never shipped.

`gitcha install` extracts into `gitcha_modules/<name>/` and writes
`gitcha-lock.json` with the exact version and SHA-256 hash. Commit the
lockfile. A later install fails loudly if the bytes don't match.

Working examples are in [`examples/`](examples).

---

## Server configuration

All settings are environment variables.

| Variable | Default | Meaning |
|---|---|---|
| `GITCHA_PORT` / `GITCHA_HOST` | `4873` / `127.0.0.1` | Listen address |
| `GITCHA_PUBLIC_URL` | `http://localhost:4873` | External URL. Use `https://…` in production (enables `Secure` cookies) |
| `GITCHA_DATA_DIR` | `./gitcha-data` | Database, package blobs and `secret.key` |
| `GITCHA_SECRET_KEY` | generated into `secret.key` | 32-byte base64 key for encrypting passwords and TOTP secrets at rest |
| `GITCHA_ISSUER` | `Gitcha` | Name shown in authenticator apps |
| `GITCHA_OPEN_REGISTRATION` | `true` | `false` lets only the first (admin) account register |
| `GITCHA_PUBLIC_READ` | `false` | Allow anonymous browsing and installs |
| `GITCHA_STEPUP_INTERVAL` | `12h` | Periodic re-verification interval (`30m`, `4h`, `7d`…) |
| `GITCHA_SENSITIVE_WINDOW` | `10m` | Maximum age of the last code for publish, yank, revoke and settings changes |
| `GITCHA_STEPUP_ON_NEW_NETWORK` | `true` | Default for the new-network check |
| `GITCHA_LOCKED_CHECKS` | *(empty)* | Comma list of `interval`, `new_network`, `sensitive` that users can't turn off |
| `GITCHA_SESSION_MAX_AGE` / `GITCHA_SESSION_IDLE` | `30d` / `7d` | Hard and idle lifetime of sessions and device tokens |
| `GITCHA_MAX_PACKAGE_BYTES` | `26214400` | Maximum tarball size |
| `GITCHA_TRUST_PROXY` | `false` | Use `X-Forwarded-For` for client IPs (only behind your own proxy) |

**Production checklist:** put Gitcha behind a TLS-terminating reverse proxy
(Caddy, nginx), set `GITCHA_PUBLIC_URL=https://…` and
`GITCHA_TRUST_PROXY=true`, back up `GITCHA_DATA_DIR`, and store `secret.key`
separately from database backups. If you lose the key, no one can sign in.

The JSON-file store is built for small and medium teams (thousands of
packages). The `Store` class in `server/src/store.js` is the only place that
touches disk if you want to swap in a database.

---

## HTTP API

All endpoints are under `/api/v1` and use `Authorization: Bearer <device token>`.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/health` | Version and policy |
| `POST` | `/auth/login` | `{username, password}` → `{mfa_ticket}` |
| `POST` | `/auth/login/mfa` | `{ticket, code, device_name}` → `{token}` |
| `POST` | `/auth/step-up` | `{code}`: completes an intermittent check |
| `GET` | `/auth/whoami` | Always allowed; reports whether a check is due |
| `POST` | `/auth/logout` | Revokes the token |
| `GET` / `PUT` | `/security` | `{checks: {interval, new_network, sensitive}}`; `PUT` needs a fresh code |
| `GET` | `/packages?q=` | Search |
| `GET` | `/packages/:name` | Details and versions |
| `GET` | `/packages/:name/:version/tarball` | `version` may be `latest`; sends `X-Gitcha-Integrity` |
| `PUT` | `/packages` | `{tarball: base64, integrity, team?, private?}`; sensitive |
| `POST` | `/packages/:name/:version/yank` | `{yanked: true\|false}`; sensitive |
| `POST` | `/packages/:name/transfer` | `{team}`: move into a team; sensitive |
| `POST` | `/packages/:name/visibility` | `{private: true\|false}` for team packages; sensitive |
| `GET` / `POST` | `/teams` | List your teams / create `{name, description}` |
| `GET` | `/teams/:team` | Members, roles and packages (members only) |
| `PUT` | `/teams/:team/members/:username` | `{role}`: add or change; owners; sensitive |
| `DELETE` | `/teams/:team/members/:username` | Remove (owners) or leave (self); sensitive |
| `DELETE` | `/teams/:team` | Delete an empty team; owners; sensitive |

When a check is due, the API answers:

```json
{ "error": "mfa_required", "reason": "interval | new_network | sensitive_action", "message": "…" }
```

---

## Security model

See [SECURITY.md](SECURITY.md) for the full model. In short:

- **Passwords:** never stored in plaintext anywhere. The server stores
  `AES-256-GCM(scrypt(password))`. Clients never write them to disk.
- **TOTP secrets:** AES-256-GCM encrypted. Codes are single-use and
  rate-limited.
- **Tokens and recovery codes:** stored only as SHA-256 hashes.
- **2FA:** required to sign in on the web and in the CLI, and to set up any
  device, including the Claude extension's. Follow-up checks are
  server-enforced, user-toggleable with a fresh code, and admin-lockable.
- **Teams:** role-checked on every request; team-only packages answer 404 to
  outsiders; membership changes need a fresh code and are audit-logged for
  both sides.
- **Claude:** never handles passwords, can't produce 2FA codes, and can't turn
  checks off without a code from you.

---

## Project layout

```
gitcha/
├── server/                    registry server (Node, one dependency: qrcode)
│   ├── src/
│   │   ├── index.js           entry point / config banner
│   │   ├── app.js             HTTP app wiring
│   │   ├── auth.js            accounts, 2FA, sessions, intermittent-check policy
│   │   ├── totp.js            RFC 6238 TOTP (Google Authenticator compatible)
│   │   ├── crypto.js          scrypt, AES-256-GCM secret box, tokens
│   │   ├── packages.js        publish / search / download / yank / transfer
│   │   ├── teams.js           teams, roles and membership
│   │   ├── api.js             JSON API
│   │   ├── web.js, views.js   web UI
│   │   └── store.js           atomic JSON store + blob storage
│   ├── public/                CSS + logo
│   └── test/
├── extension/                 Claude extension + CLI (zero dependencies)
│   ├── bin/gitcha.js          CLI
│   ├── bin/gitcha-mcp.js      MCP server (the Claude extension)
│   ├── lib/                   API client, credentials, tar, installer, MCP
│   ├── .claude-plugin/        Claude Code plugin manifest
│   ├── .mcp.json              MCP server registration for the plugin
│   ├── skills/ commands/ hooks/
│   ├── manifest.json          Claude Desktop extension manifest
│   └── test/
├── .claude-plugin/marketplace.json
├── examples/                  sample packages
├── scripts/screenshots.mjs    regenerates docs/screenshots
└── docs/screenshots/
```

---

## Development

```bash
npm test
```

```bash
npm run screenshots
```

The tests cover RFC 4226/6238 TOTP vectors, encryption at rest, replay
protection, rate limiting, enrollment, interval and new-network checks, check
toggles and admin locks, recovery codes, maintainer permissions, team roles,
team-only visibility, transfers, last-owner protection, malicious tarballs,
and an end-to-end run of the CLI and MCP server against a live
server. Screenshot generation needs Playwright with Chromium and takes about
two minutes, because each 2FA code must come from a new 30-second window.

Contributions are welcome. Please keep the client dependency-free and every
new endpoint behind the same 2FA policy.

---

## License

Gitcha is free software: you can redistribute it and/or modify it under the
terms of the **GNU Affero General Public License v3.0 or later**. See
[LICENSE](LICENSE). The AGPL makes sure that anyone who runs a modified Gitcha
server for others shares their changes too.
