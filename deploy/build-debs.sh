#!/bin/sh
# build-debs.sh -- build Gitcha's two .deb packages, in alphaOS's packaging idiom.
# Copyright 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Corwin Brust <corwin@bru.st> and Contributors.
# SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
#
# usage:  sh deploy/build-debs.sh OUT_DIR
#
#   inputloop-gitcha         the server: registry, forge (git over HTTPS and SSH), hosting, functions'
#                            control plane, billing, the social side, operations; runs as user "gitcha"
#   inputloop-gitcha-runner  the runner: CI jobs and functions in bContain VMs; runs as user "gitcha-runner"
#
# Plain dpkg-deb, no root.  The server's two npm dependencies (graphql, qrcode) are fetched once at build time
# with "npm ci --omit=dev" from the committed lockfile.  As in alphaOS, no package starts or enables a service by
# itself: a person turns each on (README.Debian says how).  The version is X.Y.Z+git<sha7>.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
OUT=${1:?usage: build-debs.sh OUT_DIR}
mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd)
MAINT="inputloop <nathanielfrankford@gmail.com>"
REV=$(git -C "$here" rev-parse --short=7 HEAD 2>/dev/null || echo nogit)
VER=$(node -p "require('$here/package.json').version")+git$REV

# A stage directory of our own: alphaOS's other parts share $OUT/.stage, which this script must not remove.
STAGE=$OUT/.stage-gitcha
stage() { S=$STAGE/$1; rm -rf "$S"; mkdir -p "$S/DEBIAN" "$S/usr/share/doc/$1"; }
finish() {   # finish NAME DEPENDS DESCRIPTION [RECOMMENDS]
  n=$1 dep=$2 desc=$3 rec=${4:-}
  printf 'Copyright 2026 Bryant Frankford and Corwin Brust and Contributors.\nCode: GPL-3.0-or-later OR LGPL-3.0-or-later. Writing: CC-BY-SA-4.0 (TERMS v2, 2026-10-10).\nThe full texts: /usr/share/common-licenses/GPL-3 and LGPL-3.\n' > "$S/usr/share/doc/$n/copyright"
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
wrapper() { mkdir -p "$S/$(dirname "$1")"; printf '#!/bin/sh\nexec %s "$@"\n' "$2" > "$S/$1"; chmod 755 "$S/$1"; }

# ---- inputloop-gitcha (the server) ----------------------------------------------------------------
stage inputloop-gitcha
APP=$S/usr/share/inputloop/gitcha
mkdir -p "$APP/extension"
cp "$here/package.json" "$here/package-lock.json" "$APP/"
cp -R "$here/server" "$APP/server"; rm -rf "$APP/server/test" "$APP/server/node_modules"
cp -R "$here/extension/lib" "$here/extension/package.json" "$APP/extension/"
mkdir -p "$APP/runner"; cp "$here/runner/package.json" "$APP/runner/"
( cd "$APP" && npm ci --omit=dev --workspace server --include-workspace-root=false --ignore-scripts --no-audit --no-fund >/dev/null )
wrapper usr/bin/gitcha-server "node /usr/share/inputloop/gitcha/server/src/index.js"
wrapper usr/bin/gitcha-ssh-keys "node /usr/share/inputloop/gitcha/server/bin/gitcha-ssh-keys.js"
wrapper usr/bin/gitcha-git-shell "node /usr/share/inputloop/gitcha/server/bin/gitcha-git-shell.js"
mkdir -p "$S/etc/inputloop/gitcha" "$S/usr/lib/systemd/system"
cp "$here/deploy/gitcha.env" "$S/etc/inputloop/gitcha/gitcha.env"
printf '/etc/inputloop/gitcha/gitcha.env\n' > "$S/DEBIAN/conffiles"
cp "$here/deploy/gitcha.service" "$S/usr/lib/systemd/system/gitcha.service"
cp "$here/deploy/Caddyfile.example" "$here/deploy/sshd-gitcha.conf.example" "$here/DEPLOY.md" "$S/usr/share/doc/inputloop-gitcha/"
cat > "$S/usr/share/doc/inputloop-gitcha/README.Debian" <<'EOF'
Gitcha does not start by itself.  To turn it on:

  1. Edit /etc/inputloop/gitcha/gitcha.env (public URL, hosting domains, and so on).
  2. systemctl enable --now gitcha        (listens on 127.0.0.1:4873 only)
  3. Put a TLS proxy in front: /usr/share/doc/inputloop-gitcha/Caddyfile.example.
  4. For git over SSH: /usr/share/doc/inputloop-gitcha/sshd-gitcha.conf.example.

Its data (database, git repositories, sites, the keys it encrypts with) is /var/lib/gitcha.
Back up /var/lib/gitcha/db.json and the repositories; keep secret.key apart from those backups.
DEPLOY.md, beside this file, is the full guide.
EOF
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
finish inputloop-gitcha "nodejs (>= 20), git, adduser" "Gitcha: forge, registry, hosting and community for inputloop
Self-hosted packages, git repositories (HTTPS and SSH), static sites with custom
domains, CI and lambda functions run by separate runners, billing with Stripe and
PayPal, agents and Second Reader reviews, a social crawl, and operations tickets.
Every account uses a password and an authenticator app.  Does not start by itself." "gnupg, openssh-server, caddy"

# ---- inputloop-gitcha-runner ----------------------------------------------------------------------
stage inputloop-gitcha-runner
APP=$S/usr/share/inputloop/gitcha-runner
mkdir -p "$APP/extension"
cp -R "$here/runner" "$APP/runner"; rm -rf "$APP/runner/test"
cp -R "$here/extension/lib" "$APP/extension/"
wrapper usr/bin/gitcha-runner "node /usr/share/inputloop/gitcha-runner/runner/bin/gitcha-runner.js"
mkdir -p "$S/usr/lib/systemd/system"
cp "$here/deploy/gitcha-runner.service" "$S/usr/lib/systemd/system/gitcha-runner.service"
cat > "$S/usr/share/doc/inputloop-gitcha-runner/README.Debian" <<'EOF'
The runner does not start by itself.  It runs every job in its own bContain VM.

  1. Install bContain and check it: bcontain doctor
  2. Get a registration token from Gitcha (an administrator, or a team owner for a team runner).
  3. sudo -u gitcha-runner GITCHA_RUNNER_HOME=/var/lib/gitcha-runner \
       gitcha-runner register --server https://gitcha.example --token TOKEN --name "$(hostname)" --backend bcontain
  4. systemctl enable --now gitcha-runner

The runner needs /dev/kvm (the gitcha-runner account is added to the kvm group) or bContain falls back to
software emulation, which is slow.  Inside an alphaOS VM that means nested virtualization on the host.
EOF
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
