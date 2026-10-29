#!/bin/sh
# apt-repo.sh -- put Gitcha's .deb files in a signed apt repository that any number of hosts can install from.
# Copyright 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Corwin Brust <corwin@bru.st> and Contributors.
# SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
#
# usage:  sh deploy/apt-repo.sh REPO_DIR [--sign KEYID] DEB...
#
# A "flat" repository: the .debs, Packages, Packages.gz and Release side by side in REPO_DIR, which works for
# every architecture (the packages are Architecture: all).  Run it again with new .debs to add them; older
# ones stay, and apt takes the highest version.  Serve REPO_DIR over HTTPS with any web server (a Gitcha site
# will do), then on each host:
#
#   deb [signed-by=/usr/share/keyrings/inputloop-archive-keyring.gpg] https://apt.example.org/gitcha ./
#
# --sign KEYID signs Release (InRelease and Release.gpg) with that gpg key and exports its public half as
# inputloop-archive-keyring.gpg, the file the hosts install under /usr/share/keyrings.  Unsigned repositories
# need [trusted=yes] on the host, which lets anyone between the host and the repository change the packages.
# Needs: apt-utils (apt-ftparchive), gzip, and gpg for --sign.
set -eu
REPO=${1:?usage: apt-repo.sh REPO_DIR [--sign KEYID] DEB...}
shift
KEY=
if [ "${1:-}" = --sign ]; then KEY=${2:?--sign needs a gpg key id}; shift 2; fi
[ $# -gt 0 ] || { echo "apt-repo.sh: name at least one .deb" >&2; exit 2; }
command -v apt-ftparchive >/dev/null || { echo "apt-repo.sh: needs apt-ftparchive (apt-get install apt-utils)" >&2; exit 1; }
if [ -n "$KEY" ]; then command -v gpg >/dev/null || { echo "apt-repo.sh: --sign needs gpg" >&2; exit 1; }; fi
mkdir -p "$REPO"
for deb in "$@"; do
  case $deb in *.deb) ;; *) echo "apt-repo.sh: not a .deb: $deb" >&2; exit 2 ;; esac
  cp "$deb" "$REPO/"
done
cd "$REPO"
apt-ftparchive packages . > Packages
gzip -9nkf Packages
apt-ftparchive \
  -o APT::FTPArchive::Release::Origin=inputloop -o APT::FTPArchive::Release::Label=Gitcha \
  -o APT::FTPArchive::Release::Suite=stable -o APT::FTPArchive::Release::Codename=stable \
  -o APT::FTPArchive::Release::Architectures=all \
  -o APT::FTPArchive::Release::Description="Gitcha packages from inputloop" \
  release . > Release
rm -f InRelease Release.gpg
if [ -n "$KEY" ]; then
  gpg --batch --yes --local-user "$KEY" --clearsign -o InRelease Release
  gpg --batch --yes --local-user "$KEY" --armor --detach-sign -o Release.gpg Release
  gpg --batch --yes --export "$KEY" > inputloop-archive-keyring.gpg
  line="deb [signed-by=/usr/share/keyrings/inputloop-archive-keyring.gpg] https://YOUR.HOST/PATH ./"
else
  echo "apt-repo.sh: not signed (no --sign); hosts must trust it blindly" >&2
  line="deb [trusted=yes] https://YOUR.HOST/PATH ./"
fi
echo "repository in $(pwd): $(grep -c '^Package:' Packages) package file(s)"
echo "on each host: $line"
