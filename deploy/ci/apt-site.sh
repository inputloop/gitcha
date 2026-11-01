#!/bin/sh
# SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
# SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
# SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
# apt-site.sh -- turn built .deb files into an apt repository that is also a small web site: the CI pipeline's
# last step (deploy/ci/gitcha-ci.json), whose output a Gitcha site serves.
#
# usage:  sh deploy/ci/apt-site.sh DEB_DIR SITE_DIR
#
# SITE_DIR gets the .debs, Packages, Packages.gz and Release (deploy/apt-repo.sh, a flat repository),
# SHA256SUMS, and index.html saying how to install from it. APT_URL (the site's own https address), when set,
# is written into the instructions; otherwise they say "this site's address".
#
# Signing: when APT_SIGNING_KEY holds an armored private GPG key (a pipeline secret: stage.sh --sign), the
# repository is signed with it (InRelease, Release.gpg) and its public half is published as
# inputloop-archive-keyring.gpg, so hosts use signed-by= instead of trusted=yes. APT_SIGNING_PASSPHRASE, if
# set, unlocks it. The key lives only in a temporary keyring that is destroyed when this script ends.
# Without it the repository is not signed and hosts must trust it blindly ([trusted=yes]): serve it only
# over https from your own domain (README.md, "Debian packages from CI").
set -eu
here=$(cd "$(dirname "$0")/../.." && pwd)
DEBS=${1:?usage: apt-site.sh DEB_DIR SITE_DIR}
SITE=${2:?usage: apt-site.sh DEB_DIR SITE_DIR}
set -- "$DEBS"/*.deb
[ -e "$1" ] || { echo "apt-site.sh: no .deb files in $DEBS" >&2; exit 1; }
rm -rf "$SITE"
FPR=
if [ -n "${APT_SIGNING_KEY:-}" ]; then
  command -v gpg >/dev/null || { echo "apt-site.sh: APT_SIGNING_KEY is set but gpg is not installed" >&2; exit 1; }
  GNUPGHOME=$(mktemp -d); export GNUPGHOME
  chmod 700 "$GNUPGHOME"
  trap 'gpgconf --kill gpg-agent >/dev/null 2>&1 || true; rm -rf "$GNUPGHOME"' EXIT
  if [ -n "${APT_SIGNING_PASSPHRASE:-}" ]; then
    (umask 077; printf '%s' "$APT_SIGNING_PASSPHRASE" > "$GNUPGHOME/passphrase")
    printf 'pinentry-mode loopback\npassphrase-file %s\n' "$GNUPGHOME/passphrase" > "$GNUPGHOME/gpg.conf"
  fi
  printf '%s\n' "$APT_SIGNING_KEY" | gpg --batch --quiet --import 2>/dev/null || { echo "apt-site.sh: APT_SIGNING_KEY is not a GPG private key gpg can import" >&2; exit 1; }
  unset APT_SIGNING_KEY APT_SIGNING_PASSPHRASE
  FPR=$(gpg --batch --with-colons --list-secret-keys | awk -F: '/^fpr:/ { print $10; exit }')
  [ -n "$FPR" ] || { echo "apt-site.sh: APT_SIGNING_KEY holds no private key" >&2; exit 1; }
  sh "$here/deploy/apt-repo.sh" "$SITE" --sign "$FPR" "$@"
else
  sh "$here/deploy/apt-repo.sh" "$SITE" "$@"
fi
cd "$SITE"
sha256sum ./*.deb > SHA256SUMS
URL=${APT_URL:-https://THIS-SITE}
VER=$(sed -n 's/^Version: //p' Packages | sort -V | tail -n 1)
# The page is plain HTML with no script: every value in it is a version string or the URL above.
esc() { printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g'; }
{
  echo '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
  echo '<title>inputloop apt repository</title>'
  echo '<style>body{font:16px/1.55 system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 16px;color:#18172a}'
  echo 'h1{background:linear-gradient(90deg,#c01f7c,#177478);-webkit-background-clip:text;background-clip:text;color:transparent}'
  echo 'pre{background:#f0eef5;padding:12px;border-radius:8px;overflow-x:auto}code{font-family:ui-monospace,monospace}</style></head><body>'
  echo '<h1>inputloop apt repository</h1>'
  echo "<p>Debian and Ubuntu packages of the inputloop server (the Gitcha software), version <code>$(esc "$VER")</code>, built by CI.</p>"
  echo '<h2>Install</h2><p>Node.js 20 or newer must be installed first (NodeSource on Ubuntu 22.04). Then:</p>'
  if [ -n "$FPR" ]; then
    echo "<pre><code>curl -fsSL $(esc "$URL")/inputloop-archive-keyring.gpg | sudo tee /usr/share/keyrings/inputloop-archive-keyring.gpg &gt;/dev/null"
    echo "echo 'deb [signed-by=/usr/share/keyrings/inputloop-archive-keyring.gpg] $(esc "$URL")/ ./' | sudo tee /etc/apt/sources.list.d/inputloop.list"
    echo 'sudo apt-get update'
    echo 'sudo apt-get install inputloop-gitcha</code></pre>'
    echo '<p>Upgrades then come with <code>sudo apt-get update &amp;&amp; sudo apt-get upgrade</code>.</p>'
    echo "<p><strong>Signed</strong> by the key with fingerprint <code>$(esc "$FPR")</code>: apt refuses any package list this key did not sign. Check that fingerprint with whoever runs this repository before the first install (<code>gpg --show-keys /usr/share/keyrings/inputloop-archive-keyring.gpg</code> prints it). <a href=\"SHA256SUMS\">SHA256SUMS</a> lists every file&#39;s hash.</p>"
  else
    echo "<pre><code>echo 'deb [trusted=yes] $(esc "$URL")/ ./' | sudo tee /etc/apt/sources.list.d/inputloop.list"
    echo 'sudo apt-get update'
    echo 'sudo apt-get install inputloop-gitcha</code></pre>'
    echo '<p>Upgrades then come with <code>sudo apt-get update &amp;&amp; sudo apt-get upgrade</code>.</p>'
    echo '<p><strong>Not signed:</strong> <code>[trusted=yes]</code> tells apt to accept these packages without a signature, so use this repository only over https from a domain you control. <a href="SHA256SUMS">SHA256SUMS</a> lists every file&#39;s hash.</p>'
  fi
  echo '<h2>Packages</h2><ul>'
  for f in ./*.deb; do n=${f#./}; echo "<li><a href=\"$(esc "$n")\">$(esc "$n")</a></li>"; done
  echo '</ul></body></html>'
} > index.html
echo "apt-site.sh: $(ls ./*.deb | wc -l) package(s), version $VER, ${FPR:+signed by $FPR, }in $(pwd)"
