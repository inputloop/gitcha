---
description: Publish the package in the current directory to Gitcha
argument-hint: "[directory]"
---
<!-- SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors -->
<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

Publish the Gitcha package in `$ARGUMENTS` (or the current directory if empty).

1. Read `gitcha.json`, then call `gitcha_publish` with `dry_run: true`. It lists the exact files and the
   size and uploads nothing. Show the user the name, the version and that list.
2. Ask the user to confirm that list. A published version cannot be deleted.
3. Call `gitcha_publish` without `dry_run`. If a two-factor check is required, ask the user for their
   current authenticator code, call `gitcha_verify_2fa`, then retry.
