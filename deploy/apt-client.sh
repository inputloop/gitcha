#!/bin/sh
# apt-client.sh -- make this host pull inputloop's packages from a signed apt repository, and keep them current.
# Copyright 2026 Corwin Brust <corwin@bru.st> and Bryant Frankford <nathanielfrankford@gmail.com> and Contributors.
# SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
#
# usage:  sudo sh apt-client.sh REPO_URL [--keyring FILE|URL] [--name NAME] [--unattended] [--install PKG...]
#
#   REPO_URL      where apt-repo.sh's folder is served, for example https://apt.inputloop.com/gitcha
#   --keyring     the repository's public key (inputloop-archive-keyring.gpg beside the Packages file, the default:
#                 REPO_URL/inputloop-archive-keyring.gpg), installed as /usr/share/keyrings/NAME-archive-keyring.gpg
#   --name        the source's name (default: the last part of REPO_URL), used for the .list and keyring file names
#   --unattended  let unattended-upgrades install new versions from this origin (Origin inputloop, from apt-repo.sh)
#   --install     apt-get install these packages once the source is in place
#
# The host pulls; nothing pushes to it. That is the "route C" shape: the keeper builds and signs on a machine of
# their own, publishes a folder over HTTPS, and every host takes what is newer on its own schedule. A repository
# without a key is refused here: [trusted=yes] would let anyone between the host and the folder change a package.
set -eu
REPO=${1:?usage: apt-client.sh REPO_URL [--keyring FILE|URL] [--name NAME] [--unattended] [--install PKG...]}
shift
KEYRING= NAME= UNATTENDED=no INSTALL=
while [ $# -gt 0 ]; do
  case $1 in
    --keyring) KEYRING=${2:?}; shift 2 ;;
    --name) NAME=${2:?}; shift 2 ;;
    --unattended) UNATTENDED=yes; shift ;;
    --install) shift; INSTALL="$*"; break ;;
    *) echo "apt-client.sh: unknown option $1" >&2; exit 2 ;;
  esac
done
[ "$(id -u)" = 0 ] || { echo "apt-client.sh: run it as root (sudo)" >&2; exit 2; }
case $REPO in https://*) ;; *) echo "apt-client.sh: REPO_URL must be https://" >&2; exit 2 ;; esac
REPO=${REPO%/}
[ -n "$NAME" ] || NAME=$(basename "$REPO")
[ -n "$KEYRING" ] || KEYRING=$REPO/inputloop-archive-keyring.gpg
KEYFILE=/usr/share/keyrings/$NAME-archive-keyring.gpg
install -d -m 755 /usr/share/keyrings
tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT
case $KEYRING in
  http://*|https://*) if command -v curl >/dev/null; then curl -fsSL "$KEYRING" -o "$tmp"; else wget -q -O "$tmp" "$KEYRING"; fi ;;
  *) cp "$KEYRING" "$tmp" ;;
esac
# A keyring is binary OpenPGP (apt-repo.sh exports it so); an armored one is dearmored here.
if grep -q 'BEGIN PGP PUBLIC KEY BLOCK' "$tmp"; then gpg --dearmor < "$tmp" > "$tmp.bin" && mv "$tmp.bin" "$tmp"; fi
gpg --no-default-keyring --keyring "$tmp" --list-keys >/dev/null 2>&1 || { echo "apt-client.sh: $KEYRING is not an OpenPGP keyring; nothing changed" >&2; exit 1; }
install -m 644 "$tmp" "$KEYFILE"
echo "deb [signed-by=$KEYFILE] $REPO ./" > "/etc/apt/sources.list.d/$NAME.list"
echo "apt-client.sh: source $NAME -> $REPO (key $KEYFILE)"
if [ "$UNATTENDED" = yes ]; then
  install -d -m 755 /etc/apt/apt.conf.d
  cat > "/etc/apt/apt.conf.d/52-$NAME-unattended" <<EOF
// Written by apt-client.sh: let unattended-upgrades take new versions from the $NAME repository.
Unattended-Upgrade::Origins-Pattern { "origin=inputloop"; };
EOF
  dpkg-query -W -f='${Status}' unattended-upgrades 2>/dev/null | grep -q 'install ok installed' || echo "apt-client.sh: install unattended-upgrades for the pull to happen by itself" >&2
  echo "apt-client.sh: unattended-upgrades may take packages whose Origin is inputloop"
fi
apt-get -o DPkg::Lock::Timeout=600 update -q
if [ -n "$INSTALL" ]; then
  # shellcheck disable=SC2086 # a list of package names on purpose
  DEBIAN_FRONTEND=${DEBIAN_FRONTEND:-noninteractive} apt-get -o DPkg::Lock::Timeout=600 install -y -q $INSTALL
fi
