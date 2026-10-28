---
description: Publish the package in the current directory to Gitcha
argument-hint: "[directory]"
---
<!-- SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors -->
<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

Publish the Gitcha package in `$ARGUMENTS` (or the current directory if empty).

1. Read `gitcha.json` and show the user the name, version and the files that will be included.
2. Ask the user to confirm.
3. Call `gitcha_publish`. If a two-factor check is required, ask the user for their current
   authenticator code, call `gitcha_verify_2fa`, then retry.
