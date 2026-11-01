#!/bin/sh
# SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
# SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
# SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
# stage.sh -- get the committed source ready for a CI build of the Debian packages and their apt repository.
#
# usage:  sh deploy/ci/stage.sh OUT_DIR [--site NAME] [--url https://SITE] [--name PACKAGE] [--sign [--passphrase]]
#
# OUT_DIR gets the source of the commit checked out (git archive HEAD, without the screenshots), plus:
#   deploy/VERSION   the Debian version of that commit (deploy/version.sh), since a CI runner has no git;
#   gitcha-ci.json   the pipeline (deploy/ci/gitcha-ci.json), deploying to the site NAME ("apt" by default),
#                    or with --site none to no site at all (then fetch the result with gitcha ci artifacts);
#   gitcha.json      a package named PACKAGE ("gitcha-debian" by default) whose version is the commit's time
#                    (0.2.YYYYMMDDHHMMSS), so every commit is a newer package.
# --sign makes the pipeline sign the repository with the pipeline secret APT_SIGNING_KEY (an armored private
# GPG key: gitcha secret set APT_SIGNING_KEY --file key.asc), and --passphrase with APT_SIGNING_PASSPHRASE too.
# Then either publish it (the pipeline runs on publish):   gitcha publish OUT_DIR
#          or run it once without publishing a package:    gitcha ci run OUT_DIR
set -eu
here=$(cd "$(dirname "$0")/../.." && pwd)
OUT=${1:?usage: stage.sh OUT_DIR [--site NAME|none] [--url https://SITE] [--name PACKAGE]}
shift
SITE=apt; URL=; NAME=gitcha-debian; SIGN=; PASS=
while [ $# -gt 0 ]; do
  case $1 in
    --site) SITE=${2:?--site needs a name, or none}; shift 2 ;;
    --url) URL=${2:?--url needs the https address of the site}; shift 2 ;;
    --name) NAME=${2:?--name needs a package name}; shift 2 ;;
    --sign) SIGN=1; shift ;;
    --passphrase) PASS=1; shift ;;
    *) echo "stage.sh: unknown option $1" >&2; exit 2 ;;
  esac
done
git -C "$here" rev-parse HEAD >/dev/null 2>&1 || { echo "stage.sh: needs a git checkout of the source" >&2; exit 1; }
[ -z "$(git -C "$here" status --porcelain --untracked-files=no)" ] || echo "stage.sh: note: uncommitted changes are left out (only the commit is staged)" >&2
rm -rf "$OUT"; mkdir -p "$OUT"
git -C "$here" archive HEAD -- . ':!docs/screenshots' ':!topoforge/*.png' | tar -x -C "$OUT"
VER=$(sh "$here/deploy/version.sh")
sh "$here/deploy/version.sh" > "$OUT/deploy/VERSION"
WHEN=$(TZ=UTC git -C "$here" log -1 --format=%cd --date=format-local:%Y%m%d%H%M%S HEAD)
OUT=$(cd "$OUT" && pwd)
NAME="$NAME" SITE="$SITE" URL="$URL" WHEN="$WHEN" VER="$VER" OUT="$OUT" SIGN="$SIGN" PASS="$PASS" node -e '
  const fs = require("fs"); const e = process.env;
  const base = JSON.parse(fs.readFileSync(e.OUT + "/package.json", "utf8")).version.split(".");
  const ci = JSON.parse(fs.readFileSync(e.OUT + "/deploy/ci/gitcha-ci.json", "utf8"));
  if (e.SITE === "none") delete ci.deploy; else ci.deploy = { site: e.SITE };
  ci.env = { ...(ci.env || {}), APT_URL: e.URL };
  if (e.SIGN) ci.secrets = e.PASS ? ["APT_SIGNING_KEY", "APT_SIGNING_PASSPHRASE"] : ["APT_SIGNING_KEY"];
  fs.writeFileSync(e.OUT + "/gitcha-ci.json", JSON.stringify(ci, null, 2) + "\n");
  fs.writeFileSync(e.OUT + "/gitcha.json", JSON.stringify({
    name: e.NAME, version: `${base[0]}.${base[1]}.${e.WHEN}`,
    description: `The inputloop server (the Gitcha software) at ${e.VER}, built by CI into Debian packages and an apt repository.`,
    license: "GPL-3.0-or-later OR LGPL-3.0-or-later",
    files: ["server", "extension", "runner", "medic", "omni", "deploy", "debian", "package.json", "package-lock.json", "LICENSE", "LICENSES", "gitcha-ci.json"],
  }, null, 2) + "\n");
  // The package page shows this, not the repository README (its screenshots are left out of the stage).
  fs.writeFileSync(e.OUT + "/README.md", [
    `# ${e.NAME}`, "",
    `The inputloop server (the Gitcha software) at \`${e.VER}\`, staged for CI by \`deploy/ci/stage.sh\`.`, "",
    "Publishing it runs `gitcha-ci.json`: a runner builds the Debian packages (`deploy/build-debs.sh`) and an apt",
    "repository with an install page (`deploy/ci/apt-site.sh`)" + (e.SITE === "none" ? "; fetch it with `gitcha ci artifacts`." : `, deployed to the site \`${e.SITE}\`.`), "",
    "The full documentation is README.md in the source repository, section \"Debian packages from CI\".", "",
  ].join("\n"));
'
echo "stage.sh: staged $VER in $OUT (package $NAME, pipeline deploys to $( [ "$SITE" = none ] && echo 'no site' || echo "site $SITE")$( [ -n "$SIGN" ] && echo ', signed with the secret APT_SIGNING_KEY'))"
echo "  publish it:        gitcha publish $OUT"
echo "  or just build it:  gitcha ci run $OUT"
