#!/bin/sh
# lay-out.sh -- put one Gitcha package's files under DESTDIR, the way they sit on an installed system.
# Copyright 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Corwin Brust <corwin@bru.st> and Contributors.
# SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
#
# usage:  sh deploy/lay-out.sh server|runner|medic|omni DESTDIR [--without-cassandra] [--debconf]
#
# The one recipe for what goes where: deploy/build-debs.sh (plain dpkg-deb, alphaOS) and debian/rules
# (dpkg-buildpackage, the full packaging) both call it, so the two kinds of package hold the same files.
#
#   --without-cassandra  the build option, on by default: leave out the Cassandra driver (the server's one
#                        optional npm dependency) and ship gitcha.env with GITCHA_STORE=file
#   --debconf            for the debian/ packages: the settings debconf asks about are written to
#                        debconf.env by postinst, so gitcha.env ships them commented out
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
what=${1:?usage: lay-out.sh server|runner DESTDIR [--without-cassandra] [--debconf]}
D=${2:?usage: lay-out.sh server|runner DESTDIR [--without-cassandra] [--debconf]}
shift 2
cassandra=yes debconf=no
for opt in "$@"; do
  case $opt in
    --without-cassandra) cassandra=no ;;
    --with-cassandra) cassandra=yes ;;
    --debconf) debconf=yes ;;
    *) echo "lay-out.sh: unknown option $opt" >&2; exit 2 ;;
  esac
done
mkdir -p "$D"

# wrapper PATH COMMAND: write a tiny /usr/bin script that runs COMMAND with all its arguments.
wrapper() { mkdir -p "$D/$(dirname "$1")"; printf '#!/bin/sh\nexec %s "$@"\n' "$2" > "$D/$1"; chmod 755 "$D/$1"; }

case $what in
server)
  # The server and the shared extension/lib code (tests left out), with its npm dependencies from the lockfile.
  APP=$D/usr/share/inputloop/gitcha
  rm -rf "$APP"; mkdir -p "$APP/extension" "$APP/runner"
  cp "$here/package.json" "$here/package-lock.json" "$APP/"
  cp -R "$here/server" "$APP/server"; rm -rf "$APP/server/test" "$APP/server/node_modules"
  cp -R "$here/extension/lib" "$here/extension/package.json" "$APP/extension/"
  cp "$here/runner/package.json" "$APP/runner/"
  omit=--omit=dev
  [ "$cassandra" = no ] && omit="$omit --omit=optional"
  # shellcheck disable=SC2086 # $omit is two words on purpose
  ( cd "$APP" && npm ci $omit --workspace server --include-workspace-root=false --ignore-scripts --no-audit --no-fund >/dev/null )
  # Dotfiles in the modules (.npmignore, .eslintrc...) are for their authors, not for running them.
  find "$APP/node_modules" -name '.*' -type f -delete
  chmod 755 "$APP/server/src/index.js" "$APP/server/bin/"*.js
  if [ "$cassandra" = yes ] && [ ! -d "$APP/node_modules/cassandra-driver" ]; then
    echo "lay-out.sh: the Cassandra driver did not install; build --without-cassandra, or check the npm registry" >&2; exit 1
  fi
  wrapper usr/bin/gitcha-server "node /usr/share/inputloop/gitcha/server/src/index.js"
  wrapper usr/bin/gitcha-ssh-keys "node /usr/share/inputloop/gitcha/server/bin/gitcha-ssh-keys.js"
  wrapper usr/bin/gitcha-git-shell "node /usr/share/inputloop/gitcha/server/bin/gitcha-git-shell.js"
  wrapper usr/bin/gitcha-wait-ready "node /usr/share/inputloop/gitcha/server/bin/gitcha-wait-ready.js"
  # gitcha-check: "could the service start, and if not, why?", with the unit's settings and as the unit's user.
  cat > "$D/usr/bin/gitcha-check" <<'CHECK'
#!/bin/sh
# gitcha-check -- test what gitcha.service needs (settings, database, port) the way the unit would run it.
set -eu
[ "$(id -u)" = 0 ] || { echo "gitcha-check: run it as root (sudo gitcha-check): it reads gitcha.env and then runs as the gitcha user" >&2; exit 2; }
set -a
. /etc/inputloop/gitcha/gitcha.env
if [ -r /etc/inputloop/gitcha/debconf.env ]; then . /etc/inputloop/gitcha/debconf.env; fi
set +a
export GITCHA_DATA_DIR=/var/lib/gitcha
install -d -o gitcha -g gitcha -m 700 "$GITCHA_DATA_DIR"
echo "service:  $(systemctl is-active gitcha 2>/dev/null || true) (systemctl status gitcha; journalctl -u gitcha -e)"
exec runuser -u gitcha -p -- node /usr/share/inputloop/gitcha/server/src/index.js --check
CHECK
  chmod 755 "$D/usr/bin/gitcha-check"
  install -D -m 755 "$here/deploy/gitcha-setup-cassandra" "$D/usr/sbin/gitcha-setup-cassandra"
  mkdir -p "$D/etc/inputloop/gitcha" "$D/usr/lib/systemd/system" "$D/usr/share/doc/inputloop-gitcha"
  env=$D/etc/inputloop/gitcha/gitcha.env
  cp "$here/deploy/gitcha.env" "$env"
  [ "$cassandra" = no ] && sed -i 's/^GITCHA_STORE=cassandra$/GITCHA_STORE=file/' "$env"
  if [ "$debconf" = yes ]; then
    # debconf.env (written by postinst, read after this file) holds these; one place for each value.
    sed -i -E 's/^(GITCHA_PUBLIC_URL|GITCHA_STORE|GITCHA_CASSANDRA_CONTACT_POINTS)=/#\1=/' "$env"
    sed -i '3a # The settings debconf asks about (public URL, hosting domains, the database) are in debconf.env, written by\n# "dpkg-reconfigure inputloop-gitcha"; that file is read after this one, so it wins.' "$env"
  fi
  cp "$here/deploy/gitcha.service" "$D/usr/lib/systemd/system/gitcha.service"
  cp "$here/deploy/Caddyfile.example" "$here/deploy/nginx-gitcha.conf.example" "$here/deploy/apache-gitcha.conf.example" "$here/deploy/haproxy-gitcha.cfg.example" "$here/deploy/sshd-gitcha.conf.example" "$here/deploy/preseed.example.cfg" "$here/DEPLOY.md" "$D/usr/share/doc/inputloop-gitcha/"
  ;;
runner)
  # The runner needs only its own code and extension/lib (for tar.js). It has no npm dependencies.
  APP=$D/usr/share/inputloop/gitcha-runner
  rm -rf "$APP"; mkdir -p "$APP/extension"
  cp -R "$here/runner" "$APP/runner"; rm -rf "$APP/runner/test"
  chmod 755 "$APP/runner/bin/gitcha-runner.js" "$APP/runner/harness/"*.sh
  cp -R "$here/extension/lib" "$APP/extension/"
  wrapper usr/bin/gitcha-runner "node /usr/share/inputloop/gitcha-runner/runner/bin/gitcha-runner.js"
  mkdir -p "$D/usr/lib/systemd/system"
  cp "$here/deploy/gitcha-runner.service" "$D/usr/lib/systemd/system/gitcha-runner.service"
  ;;
medic)
  # The medic needs only its own code: Node's standard library, no npm dependencies (as the runner).
  APP=$D/usr/share/inputloop/gitcha-medic
  rm -rf "$APP"; mkdir -p "$APP"
  cp -R "$here/medic" "$APP/medic"; rm -rf "$APP/medic/test"
  chmod 755 "$APP/medic/bin/gitcha-medic.js"
  wrapper usr/bin/gitcha-medic "node /usr/share/inputloop/gitcha-medic/medic/bin/gitcha-medic.js"
  mkdir -p "$D/etc/inputloop/gitcha" "$D/usr/lib/systemd/system" "$D/usr/share/doc/inputloop-gitcha-medic"
  cp "$here/deploy/medic.env" "$D/etc/inputloop/gitcha/medic.env"
  cp "$here/deploy/gitcha-medic.service" "$here/deploy/gitcha-medic.timer" "$D/usr/lib/systemd/system/"
  ;;
omni)
  # The gateway and hub (Node's standard library only), and the extension's MCP server with its lib, so a host can
  # offer Gitcha itself as a member without the server package's node_modules.
  APP=$D/usr/share/inputloop/gitcha-omni
  rm -rf "$APP"; mkdir -p "$APP/extension"
  cp -R "$here/omni" "$APP/omni"; rm -rf "$APP/omni/test"
  cp -R "$here/extension/bin" "$here/extension/lib" "$here/extension/package.json" "$APP/extension/"
  chmod 755 "$APP/omni/bin/"*.js "$APP/extension/bin/"*.js
  wrapper usr/bin/omni-gateway "node /usr/share/inputloop/gitcha-omni/omni/bin/omni-gateway.js"
  wrapper usr/bin/omni-hub "node /usr/share/inputloop/gitcha-omni/omni/bin/omni-hub.js"
  mkdir -p "$D/etc/inputloop/omni" "$D/usr/lib/systemd/system" "$D/usr/share/doc/inputloop-gitcha-omni-gateway"
  cp "$here/deploy/omni-gateway.env" "$D/etc/inputloop/omni/gateway.env"
  cp "$here/deploy/omni-gateway.service" "$D/usr/lib/systemd/system/omni-gateway.service"
  cp "$here/deploy/omni-members.example.json" "$here/deploy/nginx-omni.conf.example" "$here/docs/proposals/omni-cloud.md" "$D/usr/share/doc/inputloop-gitcha-omni-gateway/"
  ;;
*) echo "lay-out.sh: server, runner, medic or omni, not $what" >&2; exit 2 ;;
esac
