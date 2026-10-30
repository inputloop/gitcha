#!/bin/sh
# publish.sh -- build the packages, put them in the signed apt repository, and copy that folder where it is served.
# Copyright 2026 Corwin Brust <corwin@bru.st> and Bryant Frankford <nathanielfrankford@gmail.com> and Contributors.
# SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
#
# usage:  sh deploy/publish.sh REPO_DIR --sign KEYID [--to DEST] [--debian|--debs] [--without-cassandra]
#
#   REPO_DIR            the apt repository folder (kept between runs; older versions stay, apt takes the newest)
#   --sign KEYID        the gpg key that signs Release (the keeper's; a build machine without it cannot publish)
#   --to DEST           where to copy the folder after: a local path, or user@host:/path for rsync over ssh
#   --debian            build with debian/ (dpkg-buildpackage, debconf; the default when debhelper is installed)
#   --debs              build with plain dpkg-deb (alphaOS's idiom, no debconf)
#   --without-cassandra the build option, passed through
#
# The sequence is: build-debian.sh or build-debs.sh into a scratch folder, apt-repo.sh REPO_DIR --sign KEYID, then
# rsync (or cp) REPO_DIR to DEST. Hosts set up with apt-client.sh then pull on their own (route C). Nothing here
# logs in to a host to install anything.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
REPO=${1:?usage: publish.sh REPO_DIR --sign KEYID [--to DEST] [--debian|--debs] [--without-cassandra]}
shift
KEY= DEST= HOW= OPT=
while [ $# -gt 0 ]; do
  case $1 in
    --sign) KEY=${2:?--sign needs a gpg key id}; shift 2 ;;
    --to) DEST=${2:?}; shift 2 ;;
    --debian) HOW=debian; shift ;;
    --debs) HOW=debs; shift ;;
    --without-cassandra) OPT=--without-cassandra; shift ;;
    *) echo "publish.sh: unknown option $1" >&2; exit 2 ;;
  esac
done
[ -n "$KEY" ] || { echo "publish.sh: --sign KEYID is required; an unsigned repository is not published" >&2; exit 2; }
if [ -z "$HOW" ]; then if command -v dh >/dev/null && command -v dch >/dev/null; then HOW=debian; else HOW=debs; fi; fi
OUT=$(mktemp -d); trap 'rm -rf "$OUT"' EXIT
echo "publish.sh: building with build-$HOW.sh ($(sh "$here/deploy/version.sh"))"
sh "$here/deploy/build-$HOW.sh" "$OUT" $OPT
sh "$here/deploy/apt-repo.sh" "$REPO" --sign "$KEY" "$OUT"/*.deb
if [ -n "$DEST" ]; then
  case $DEST in
    *:*) command -v rsync >/dev/null || { echo "publish.sh: --to user@host:/path needs rsync" >&2; exit 1; }
         rsync -a --delete "$REPO/" "$DEST/" && echo "publish.sh: copied $REPO to $DEST" ;;
    *) mkdir -p "$DEST" && cp -a "$REPO/." "$DEST/" && echo "publish.sh: copied $REPO to $DEST" ;;
  esac
fi
echo "publish.sh: done. Hosts pull with: sudo sh apt-client.sh https://.../$(basename "$REPO") --unattended --install inputloop-gitcha inputloop-gitcha-medic"
