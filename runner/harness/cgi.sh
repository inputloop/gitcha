#!/bin/sh
# SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
# SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
# cgi.sh: the Gitcha function harness for runtime "sh". It runs inside the sandbox.
# A harness is the small wrapper that calls the user's function and sends back its answer.
# usage: sh cgi.sh ENTRY BODYFILE
# It works like classic CGI (an old, simple way for a web server to run a script):
# the request arrives as the variables REQUEST_METHOD, PATH_INFO, QUERY_STRING,
# CONTENT_TYPE and HTTP_*, with the body on stdin. The script prints optional
# header lines ("Status: 201", "Content-Type: ..."), a blank line, then the body.
# With no header block, everything is a text/plain body.
# The whole output leaves base64-encoded (turned into plain letters and digits)
# on one marker line, together with the script's exit code.
entry=$1; body=$2
out=$(mktemp); err=0
sh "$entry" < "$body" > "$out" || err=$?
printf '\n@@GITCHA-RESPONSE-CGI@@ %s %s\n' "$err" "$(base64 < "$out" | tr -d '\n')"
rm -f "$out"
exit "$err"
