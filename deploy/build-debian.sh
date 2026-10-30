#!/bin/sh
# build-debian.sh -- build the full Debian packages (debian/, debhelper, debconf) from the committed tree.
# Copyright 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Corwin Brust <corwin@bru.st> and Contributors.
# SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
#
# usage:  sh deploy/build-debian.sh OUT_DIR [--without-cassandra]
#
# Exports HEAD (git archive, so only committed files ship) into a scratch folder, gives it a snapshot
# version X.Y.Z+gitYYYYMMDDHHMMSS.<sha7> in debian/changelog (deploy/version.sh, as build-debs.sh), and runs
# dpkg-buildpackage there.  Cassandra is the build option on by default; --without-cassandra builds with
# the pkg.gitcha.nocassandra profile.  The .deb, .buildinfo and .changes files land in OUT_DIR.
# Needs: dpkg-dev, debhelper (>= 13), devscripts (for dch), git, and Node.js 20+ with npm.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
OUT=${1:?usage: build-debian.sh OUT_DIR [--without-cassandra]}
PROFILE=
case ${2:-} in
  '') ;;
  --without-cassandra) PROFILE=pkg.gitcha.nocassandra ;;
  *) echo "build-debian.sh: unknown option $2" >&2; exit 2 ;;
esac
mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd)
REV=$(git -C "$here" rev-parse --short=7 HEAD)
VER=$(sh "$here/deploy/version.sh")
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
git -C "$here" archive --format=tar --prefix=gitcha/ HEAD | tar -x -C "$WORK"
cd "$WORK/gitcha"
DEBEMAIL="nathanielfrankford@gmail.com" DEBFULLNAME="inputloop" \
  dch --newversion "$VER" --distribution unstable --force-distribution "Snapshot of commit $REV." >/dev/null 2>&1
# Node.js often comes from NodeSource or a tarball rather than Debian's nodejs package, which dpkg cannot see:
# check it here, then let dpkg-buildpackage skip its build-dependency check (-d).
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || { echo "build-debian.sh: needs Node.js 20 or later" >&2; exit 1; }
command -v npm >/dev/null || { echo "build-debian.sh: needs npm" >&2; exit 1; }
dpkg-buildpackage -us -uc -b -d ${PROFILE:+-P"$PROFILE"} >"$WORK/build.log" 2>&1 || { tail -40 "$WORK/build.log" >&2; exit 1; }
for f in "$WORK"/*.deb "$WORK"/*.buildinfo "$WORK"/*.changes; do cp "$f" "$OUT/"; echo "built $OUT/$(basename "$f")"; done
