#!/bin/sh
# version.sh -- print the Debian version of the commit being built: X.Y.Z+gitYYYYMMDDHHMMSS.<sha7>
# Copyright 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Corwin Brust <corwin@bru.st> and Contributors.
# SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
#
# usage:  sh deploy/version.sh [COMMIT]     (default HEAD)
#
# X.Y.Z is package.json's version.  The commit's time (UTC, committer date) comes before its hash, because dpkg and
# apt compare versions piece by piece: with the hash alone (+git68938bb against +gitbf570a2) a newer commit can sort
# as older, and apt then never upgrades to it.  The time only grows along one branch, so every new build of main is
# newer to apt; the hash still says exactly which commit it is.  The same commit always gets the same version: to
# reinstall a rebuild of it, use apt install --reinstall.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
commit=${1:-HEAD}
base=$(git -C "$here" show "$commit:package.json" | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')
when=$(TZ=UTC git -C "$here" log -1 --format=%cd --date=format-local:%Y%m%d%H%M%S "$commit")
sha=$(git -C "$here" rev-parse --short=7 "$commit")
echo "$base+git$when.$sha"
