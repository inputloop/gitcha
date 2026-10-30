#!/bin/sh
# build-debs.sh -- build Gitcha's two .deb packages, in alphaOS's packaging idiom.
# Copyright 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Corwin Brust <corwin@bru.st> and Contributors.
# SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
#
# usage:  sh deploy/build-debs.sh OUT_DIR [--without-cassandra]
#
#   inputloop-gitcha         the server: registry, forge (git over HTTPS and SSH), hosting, functions'
#                            control plane, billing, the social side, operations; runs as user "gitcha"
#   inputloop-gitcha-runner  the runner: CI jobs and functions in bContain VMs; runs as user "gitcha-runner"
#
# A .deb is the package file that Debian and Ubuntu install with dpkg or apt.
# This script uses plain dpkg-deb and needs no root.  The server's npm dependencies (graphql, qrcode, and
# cassandra-driver unless --without-cassandra) are downloaded once at build time from the committed lockfile.
# Cassandra is the build option on by default: the package then ships GITCHA_STORE=cassandra and recommends
# the cassandra package; --without-cassandra leaves the driver out and ships GITCHA_STORE=file.
# deploy/lay-out.sh is the recipe for which files go where; debian/ (dpkg-buildpackage) uses it too.
# As in alphaOS, no package starts or enables a service by itself: a person turns each one on
# (README.Debian says how).  The version is X.Y.Z+gitYYYYMMDDHHMMSS.<sha7>: the commit's time, then its hash.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
OUT=${1:?usage: build-debs.sh OUT_DIR [--without-cassandra]}
CASSANDRA=--with-cassandra
case ${2:-} in
  '') ;;
  --without-cassandra) CASSANDRA=--without-cassandra ;;
  *) echo "build-debs.sh: unknown option $2" >&2; exit 2 ;;
esac
mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd)
MAINT="inputloop <nathanielfrankford@gmail.com>"
# X.Y.Z+gitYYYYMMDDHHMMSS.<sha7>: the commit's time first, so apt sees every newer commit as newer (deploy/version.sh).
if git -C "$here" rev-parse HEAD >/dev/null 2>&1; then
  VER=$(sh "$here/deploy/version.sh")
  # This script packs the working tree as it is, so uncommitted changes would ship under the commit's version.
  [ -z "$(git -C "$here" status --porcelain --untracked-files=no)" ] || echo "build-debs.sh: warning: uncommitted changes are in this build, but not in its version ($VER)" >&2
else
  VER=$(node -p "require('$here/package.json').version")+nogit
fi

# A stage folder of our own, where each package's files are laid out before packing.
# alphaOS's other parts share $OUT/.stage, which this script must not remove.
# stage NAME: start an empty stage folder for one package.
STAGE=$OUT/.stage-gitcha
stage() { S=$STAGE/$1; rm -rf "$S"; mkdir -p "$S/DEBIAN" "$S/usr/share/doc/$1"; }
# finish NAME DEPENDS DESCRIPTION [RECOMMENDS]: write the copyright file and the DEBIAN/control file
# (the package's name, version, needs and description), then build the .deb into OUT_DIR.
finish() {   # finish NAME DEPENDS DESCRIPTION [RECOMMENDS]
  n=$1 dep=$2 desc=$3 rec=${4:-}
  cp "$here/debian/copyright" "$S/usr/share/doc/$n/copyright"
  size=$(du -sk --exclude=DEBIAN "$S" | cut -f1)
  {
    echo "Package: $n"; echo "Version: $VER"; echo "Architecture: all"; echo "Maintainer: $MAINT"
    echo "Installed-Size: $size"; echo "Depends: $dep"; [ -n "$rec" ] && echo "Recommends: $rec"
    echo "Section: misc"; echo "Priority: optional"; echo "Homepage: https://github.com/inputloop/gitcha"
    echo "Description: $desc" | head -1
    echo "$desc" | tail -n +2 | sed 's/^$/./; s/^/ /'
  } > "$S/DEBIAN/control"
  find "$S" -type d -exec chmod 755 {} +
  dpkg-deb --root-owner-group --build "$S" "$OUT/${n}_${VER}_all.deb" >/dev/null
  echo "built $OUT/${n}_${VER}_all.deb"
}

# ---- inputloop-gitcha (the server) ----------------------------------------------------------------
# lay-out.sh copies the server, its npm dependencies, the command wrappers, the config file, the systemd
# service and the docs.
stage inputloop-gitcha
sh "$here/deploy/lay-out.sh" server "$S" $CASSANDRA
# conffiles tells dpkg that gitcha.env is a config file, so an upgrade keeps the admin's changes.
printf '/etc/inputloop/gitcha/gitcha.env\n' > "$S/DEBIAN/conffiles"
cp "$here/debian/inputloop-gitcha.README.Debian" "$S/usr/share/doc/inputloop-gitcha/README.Debian"
# postinst runs after install: it makes the "gitcha" system user and locks down gitcha.env (mode 640).
cat > "$S/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
if [ "$1" = configure ]; then
  getent group gitcha >/dev/null || addgroup --system gitcha
  getent passwd gitcha >/dev/null || adduser --system --ingroup gitcha --home /var/lib/gitcha --shell /bin/sh gitcha
  chown root:gitcha /etc/inputloop/gitcha/gitcha.env; chmod 640 /etc/inputloop/gitcha/gitcha.env
  systemctl daemon-reload >/dev/null 2>&1 || true
  # Nothing starts by itself, but a service that is running keeps the old code until it restarts.
  systemctl try-restart gitcha.service >/dev/null 2>&1 || true
fi
EOF
chmod 755 "$S/DEBIAN/postinst"
REC="gnupg, openssh-server, caddy"
[ "$CASSANDRA" = --with-cassandra ] && REC="cassandra, $REC"
finish inputloop-gitcha "nodejs (>= 20), git, adduser" "Gitcha: forge, registry, hosting and community for inputloop
Self-hosted packages, git repositories (HTTPS and SSH), static sites with custom
domains, CI and lambda functions run by separate runners, billing with Stripe and
PayPal, agents and Second Reader reviews, a social crawl, and operations tickets.
Every account uses a password and an authenticator app.  Does not start by itself." "$REC"

# ---- inputloop-gitcha-runner ----------------------------------------------------------------------
# The runner needs only its own code and extension/lib (for tar.js). It has no npm dependencies.
stage inputloop-gitcha-runner
sh "$here/deploy/lay-out.sh" runner "$S"
cp "$here/debian/inputloop-gitcha-runner.README.Debian" "$S/usr/share/doc/inputloop-gitcha-runner/README.Debian"
# postinst makes the "gitcha-runner" system user and adds it to the kvm group when there is one,
# so bContain can use hardware virtualization.
cat > "$S/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
if [ "$1" = configure ]; then
  getent group gitcha-runner >/dev/null || addgroup --system gitcha-runner
  getent passwd gitcha-runner >/dev/null || adduser --system --ingroup gitcha-runner --home /var/lib/gitcha-runner --shell /usr/sbin/nologin gitcha-runner
  getent group kvm >/dev/null && adduser gitcha-runner kvm >/dev/null || true
  systemctl daemon-reload >/dev/null 2>&1 || true
fi
EOF
chmod 755 "$S/DEBIAN/postinst"
finish inputloop-gitcha-runner "nodejs (>= 20), adduser" "Gitcha runner: CI jobs and functions in bContain VMs
Registers with a Gitcha server, takes jobs, runs each in its own throwaway
bContain VM, streams the log back and reports the result.  Does not start by itself." "bcontain"
rm -rf "$STAGE"
