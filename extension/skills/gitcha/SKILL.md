---
name: gitcha
description: Use when the user wants to find, install, publish or yank packages on their Gitcha registry, manage Gitcha teams or share packages with a team, check their Gitcha sign-in, or change Gitcha two-factor check settings. Explains the 2FA rules the gitcha_* tools enforce.
---

# Working with a Gitcha registry

Gitcha is a self-hosted package registry. Every account has a password **and** a
TOTP authenticator (Google Authenticator, Authy, Aegis, 1Password...).

## First run

If any `gitcha_*` tool says Gitcha is not set up, the user must sign in once in
their own terminal:

```bash
gitcha login --server https://their-registry.example
```

Never ask for, accept, or type the user's password. If they paste one, tell
them to change it.

## Intermittent two-factor checks

The registry may answer "Two-factor check required". This happens:

- periodically (default every 12 hours),
- when the device connects from a new network,
- before sensitive actions (publish, yank, changing security settings).

When it happens:

1. Tell the user why (the tool output says), and ask for the **current 6-digit
   code** from their authenticator app.
2. Call `gitcha_verify_2fa` with exactly what they typed.
3. Retry the original tool call.

Never guess, generate, or reuse a code. Codes are single-use and expire in
about 30 seconds, so ask right before you need it.

## Publishing

1. Make sure the directory has a `gitcha.json` with `name`, `version`,
   `description` and `license`. Bump `version`: published versions are immutable.
2. Show the user what will be published and confirm.
3. Call `gitcha_publish`; expect a 2FA check.

## Installing

`gitcha_install` downloads into `gitcha_modules/<name>`, verifies SHA-256
integrity and records it in `gitcha-lock.json`. Commit the lockfile.

## Teams and shared packages

- `gitcha_teams` lists the user's teams; pass `name` to see members and packages.
- `gitcha_team_create` starts a team; the user becomes its owner.
- `gitcha_team_member` adds, re-roles (`member`, `maintainer`, `owner`) or removes
  people. Only do this when the user names the person and role. It needs a
  fresh 2FA code.
- To share a package: publish with `team` (and `private: true` for team-only),
  or move an existing one with `gitcha_share_package`. Confirm first.
- Owners manage members, maintainers publish, members can see team-only
  packages. A team always keeps at least one owner.

## Toggling follow-up checks

Sign-in always needs 2FA. The follow-up checks (`interval`, `new_network`,
`sensitive`) can be turned on/off with `gitcha_security_settings`, but only when
the user explicitly asks, and a fresh code is required. Some checks may be
locked on by the administrator.
