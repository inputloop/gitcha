#!/bin/sh
# mass-install.sh -- install and configure Gitcha on many hosts at once over SSH, with no questions asked.
# Copyright 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Corwin Brust <corwin@bru.st> and Contributors.
# SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
#
# usage:  sh deploy/mass-install.sh HOSTS PRESEED --repo URL [--keyring FILE] [--package NAME]... [options]
#         sh deploy/mass-install.sh HOSTS PRESEED --deb FILE [--deb FILE]... [options]
#
#   HOSTS      one SSH destination per line (host or user@host), optionally followed by the host's Cassandra
#              instance name; blank lines and # comments are skipped
#   PRESEED    debconf answers (deploy/preseed.example.cfg).  @HOST@ becomes the host's short name and
#              @INSTANCE@ its instance name (the second column, or the short name made into a Cassandra name)
#   --repo URL      add this apt repository (deploy/apt-repo.sh made it) and install from it; with
#   --keyring FILE  its public key, installed as /usr/share/keyrings/inputloop-archive-keyring.gpg
#   --package NAME  what to install from the repository (default inputloop-gitcha; repeat for more)
#   --deb FILE      instead of a repository, copy these .debs to each host and install them
#   --parallel N    hosts at a time (default 8)
#   --logs DIR      one log per host (default ./mass-install-logs)
#
# Each host gets one SSH connection that runs one script as root (through sudo unless the user is root):
# debconf-set-selections with the host's answers, then apt-get install with DEBIAN_FRONTEND=noninteractive.
# SSH runs with BatchMode, so keys must already work; set SSH to use another command (SSH="ssh -F my.conf"),
# and SUDO to change how the script becomes root (default "sudo -n"; nothing for root@host).
# A summary lists each host as ok or failed; the exit status is 1 if any failed.
set -eu
usage() { sed -n '/^# usage:/,/^set -eu/p' "$0" | sed '$d; s/^# \{0,1\}//' >&2; exit 2; }
[ $# -ge 2 ] || usage
HOSTS=$1 PRESEED=$2
shift 2
REPO='' KEYRING='' PACKAGES='' DEBS='' PARALLEL=8 LOGS=./mass-install-logs
while [ $# -gt 0 ]; do
  case $1 in
    --repo) REPO=${2:?}; shift 2 ;;
    --keyring) KEYRING=${2:?}; shift 2 ;;
    --package) PACKAGES="$PACKAGES ${2:?}"; shift 2 ;;
    --deb) [ -f "${2:?}" ] || { echo "mass-install.sh: no such file $2" >&2; exit 2; }; DEBS="$DEBS ${2}"; shift 2 ;;
    --parallel) PARALLEL=${2:?}; shift 2 ;;
    --logs) LOGS=${2:?}; shift 2 ;;
    *) usage ;;
  esac
done
[ -f "$HOSTS" ] && [ -f "$PRESEED" ] || { echo "mass-install.sh: HOSTS and PRESEED must be files" >&2; exit 2; }
case "${REPO:+repo}${DEBS:+deb}" in repo|deb) ;; *) echo "mass-install.sh: give --repo or --deb (one of them)" >&2; exit 2 ;; esac
[ -n "$PACKAGES" ] || PACKAGES=inputloop-gitcha
: "${SSH:=ssh -o BatchMode=yes -o ConnectTimeout=15}"
# How the remote script becomes root: sudo without a password prompt, nothing for root@host, or SUDO= to skip.
SUDO=${SUDO-sudo -n}
mkdir -p "$LOGS"

# script HOST INSTANCE: the shell script one host runs as root, with everything it needs inside it.
script() {
  echo 'set -eu'
  echo 'export DEBIAN_FRONTEND=noninteractive'
  echo "debconf-set-selections <<'GITCHA_PRESEED'"
  sed "s/@HOST@/$1/g; s/@INSTANCE@/$2/g" "$PRESEED"
  echo 'GITCHA_PRESEED'
  if [ -n "$REPO" ]; then
    if [ -n "$KEYRING" ]; then
      echo "base64 -d > /usr/share/keyrings/inputloop-archive-keyring.gpg <<'GITCHA_KEY'"
      base64 < "$KEYRING"
      echo 'GITCHA_KEY'
      echo 'chmod 644 /usr/share/keyrings/inputloop-archive-keyring.gpg'
      opt='signed-by=/usr/share/keyrings/inputloop-archive-keyring.gpg'
    else
      opt='trusted=yes'
    fi
    echo "echo 'deb [$opt] $REPO ./' > /etc/apt/sources.list.d/inputloop-gitcha.list"
    echo 'apt-get update -q'
    echo "apt-get install -y -q$PACKAGES"
  else
    echo 'd=$(mktemp -d); trap '"'"'rm -rf "$d"'"'"' EXIT'
    list=
    for deb in $DEBS; do
      b=$(basename "$deb")
      echo "base64 -d > \"\$d/$b\" <<'GITCHA_DEB'"
      base64 < "$deb"
      echo 'GITCHA_DEB'
      list="$list \"\$d/$b\""
    done
    echo 'chmod 755 "$d"; chmod 644 "$d"/*.deb'
    echo "apt-get install -y -q$list"
  fi
}

# one TARGET INSTANCE: install on one host; its log is $LOGS/<host>.log, its result $LOGS/<host>.status.
one() {
  target=$1 host=${1#*@}; host=${host%%.*}
  instance=${2:-$(printf '%s' "$host" | tr -c 'A-Za-z0-9_' '_' | sed 's/^[^A-Za-z]/g&/')}
  if ! printf '%s' "$instance" | grep -Eq '^[A-Za-z][A-Za-z0-9_]{0,47}$'; then
    echo "instance name \"$instance\" is not a Cassandra name (a letter, then letters, digits or _)" > "$LOGS/$host.log"
    echo failed > "$LOGS/$host.status"; return
  fi
  sudo=$SUDO
  [ "${target%%@*}" = root ] && [ "$target" != "${target#*@}" ] && sudo=
  if script "$host" "$instance" | $SSH "$target" "$sudo sh -s" > "$LOGS/$host.log" 2>&1; then echo ok > "$LOGS/$host.status"
  else echo failed > "$LOGS/$host.status"; fi
}

n=0 all=
while read -r target instance _; do
  case $target in ''|'#'*) continue ;; esac
  one "$target" "$instance" &
  all="$all $target"
  n=$((n + 1))
  [ $((n % PARALLEL)) -eq 0 ] && wait
done < "$HOSTS"
wait

bad=0
for target in $all; do
  host=${target#*@}; host=${host%%.*}
  status=$(cat "$LOGS/$host.status" 2>/dev/null || echo failed)
  printf '%-8s %s  (%s)\n' "$status" "$target" "$LOGS/$host.log"
  [ "$status" = ok ] || bad=1
done
exit $bad
