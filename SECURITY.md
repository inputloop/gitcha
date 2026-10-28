# Security model

Gitcha is built so that **a stolen database, a stolen laptop token, or a
manipulated AI assistant is not enough** to publish or install code as you.

## What is stored, and how

| Secret | Where | How it is protected |
|---|---|---|
| Account password | server `db.json` | scrypt (N=2¹⁵, r=8, p=1, 16-byte salt), **then encrypted** with AES-256-GCM using the server key. The plaintext password is never stored anywhere. |
| TOTP (authenticator) secret | server `db.json` | AES-256-GCM with the server key. |
| Recovery codes | server `db.json` | SHA-256 hashes; each is deleted when used. |
| Web sessions / device tokens | server `db.json` | Only SHA-256 hashes of the 256-bit tokens. |
| Server key | `$GITCHA_DATA_DIR/secret.key` (0600) or `GITCHA_SECRET_KEY` | Keep it **separate from backups of `db.json`**. Losing it locks every account. |
| Device token | client `~/.config/gitcha/credentials.json` (0600) | Revocable at any time from the Account page. The client **never stores your password** or TOTP secret. |

## Authentication flow

1. **Register**: username + password, then mandatory TOTP enrollment (QR code
   for Google Authenticator / Authy / Aegis / 1Password). The account cannot
   sign in until a valid code confirms the authenticator works. Ten one-time
   recovery codes are shown once.
2. **Sign in / first install**: password → short-lived (5 min) ticket → TOTP
   code. Both web sign-in and `gitcha login` (which the Claude extension relies
   on) follow this flow. There is no way to switch this off.
3. **Intermittent checks** (server-enforced; the API answers
   `401 {"error":"mfa_required","reason":…}`):
   - `interval`: every `GITCHA_STEPUP_INTERVAL` (default 12 h).
   - `new_network`: a token is used from a new /24 (IPv4) or /48 (IPv6).
   - `sensitive`: publish, yank and device revocation need a code no older
     than `GITCHA_SENSITIVE_WINDOW` (default 10 min).
4. **Toggling checks**: each user can switch the three follow-up checks on or
   off (web Account page, `gitcha security`, or the `gitcha_security_settings`
   tool). Changing them **always** needs a fresh code, so a stolen token or a
   prompt-injected assistant cannot quietly disable them. Administrators can
   lock checks on with `GITCHA_LOCKED_CHECKS=interval,new_network,sensitive`.

## Other protections

- TOTP codes are single-use (the last accepted time step is stored) and valid
  for ±1 step (about 90 s).
- Rate limits: 10 password attempts per IP+user and 6 second-factor attempts
  per user per 15 minutes; an MFA ticket dies after 5 wrong codes.
- Unknown usernames take the same scrypt time as real ones.
- Web: `HttpOnly`, `SameSite=Lax`, `Secure` (on https) cookies; CSRF tokens on
  every form; strict CSP with no inline script; `frame-ancestors 'none'`;
  same-site-only redirects.
- API: refuses `Sec-Fetch-Site: cross-site` requests; bearer tokens only.
- Packages: SHA-256 integrity checked on upload, on download, and against
  `gitcha-lock.json`; versions are immutable; tarballs containing links,
  absolute paths or `..` are rejected on both server and client.
- The client refuses plain `http://` for anything but localhost.
- Every security-relevant event is written to a per-user audit log shown on
  the Account page.

## Teams

- Permissions are checked server-side on every request. Owners manage
  membership, maintainers publish/yank/transfer team packages, and members can
  read team-only packages.
- Team-only packages return `404` to non-members (search, info, download), and
  publishing over a hidden name returns a neutral "name not available" error,
  so outsiders can't discover them.
- Adding, removing or re-roling members, transferring packages and changing
  visibility are sensitive actions that need a fresh 2FA code. Each change is
  written to the audit log of both the acting user and the affected user.
- A team can't lose its last owner, and a team that still owns packages can't
  be deleted.
- Team names and usernames share one namespace, so a team can't impersonate a
  user.

## The Claude extension and your secrets

- The extension never asks for, receives or stores your password. First-time
  setup is `gitcha login` in **your own terminal**.
- When a 2FA check is due, the tool tells Claude to ask **you** for the current
  code. A TOTP code is short-lived and single-use, so passing it through the
  conversation is low-risk; if you prefer, run `gitcha verify` in a terminal
  instead. The extension shares the CLI's device token, so either works.
- Tool descriptions instruct Claude never to invent codes, to confirm before
  publishing or yanking, and to change 2FA settings only on your explicit
  request. The server enforces the fresh-code requirement regardless.

## Reporting a vulnerability

Please open a private security advisory on the repository rather than a public
issue.
