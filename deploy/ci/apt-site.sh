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
# The repository is not signed: a pipeline has nowhere safe to keep a signing key yet. Hosts trust it with
# [trusted=yes], so serve it only over https from your own domain (README.md, "Debian packages from CI").
set -eu
here=$(cd "$(dirname "$0")/../.." && pwd)
DEBS=${1:?usage: apt-site.sh DEB_DIR SITE_DIR}
SITE=${2:?usage: apt-site.sh DEB_DIR SITE_DIR}
set -- "$DEBS"/*.deb
[ -e "$1" ] || { echo "apt-site.sh: no .deb files in $DEBS" >&2; exit 1; }
rm -rf "$SITE"
sh "$here/deploy/apt-repo.sh" "$SITE" "$@"
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
  echo "<pre><code>echo 'deb [trusted=yes] $(esc "$URL")/ ./' | sudo tee /etc/apt/sources.list.d/inputloop.list"
  echo 'sudo apt-get update'
  echo 'sudo apt-get install inputloop-gitcha</code></pre>'
  echo '<p>Upgrades then come with <code>sudo apt-get update &amp;&amp; sudo apt-get upgrade</code>.</p>'
  echo '<p><strong>Not signed:</strong> <code>[trusted=yes]</code> tells apt to accept these packages without a signature, so use this repository only over https from a domain you control. <a href="SHA256SUMS">SHA256SUMS</a> lists every file&#39;s hash.</p>'
  echo '<h2>Packages</h2><ul>'
  for f in ./*.deb; do n=${f#./}; echo "<li><a href=\"$(esc "$n")\">$(esc "$n")</a></li>"; done
  echo '</ul></body></html>'
} > index.html
echo "apt-site.sh: $(ls ./*.deb | wc -l) package(s), version $VER, in $(pwd)"
