#!/bin/sh
# SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
# SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
# cgi.sh -- Gitcha function harness for runtime "sh". Runs inside the sandbox.
# usage: sh cgi.sh ENTRY BODYFILE
# Classic CGI: the request arrives as REQUEST_METHOD, PATH_INFO, QUERY_STRING,
# CONTENT_TYPE and HTTP_* variables with the body on stdin. The script prints
# optional header lines ("Status: 201", "Content-Type: ..."), a blank line,
# then the body. With no header block, everything is a text/plain body.
# The output leaves base64-encoded on one marker line.
entry=$1; body=$2
out=$(mktemp); err=0
sh "$entry" < "$body" > "$out" || err=$?
printf '\n@@GITCHA-RESPONSE-CGI@@ %s %s\n' "$err" "$(base64 < "$out" | tr -d '\n')"
rm -f "$out"
exit "$err"
