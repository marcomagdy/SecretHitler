#!/usr/bin/env bash
set -euo pipefail

# ── Secret Hitler — one-command remote deploy ──────────────────────────────
# Runs the steps from deploy/README.md FROM YOUR LAPTOP against a remote box:
#   1. Package the working tree (minus junk) into a tarball.
#   2. scp it to the remote machine.
#   3. ssh in, extract to /opt/secret-hitler, and run setup.sh.
#
# Usage:
#   deploy/deploy.sh [user@]HOST [PORT]
#
#   HOST   ssh target, e.g. ec2-user@1.2.3.4  (default user: ec2-user)
#   PORT   port the service should listen on  (default: 3000)
#
# Examples:
#   deploy/deploy.sh ec2-user@my-box.example.com
#   deploy/deploy.sh my-box.example.com 80
#
# Re-run it anytime to ship an update — setup.sh is idempotent and leaves the
# SQLite database in .data/ untouched.

usage() {
  echo "Usage: $0 [user@]HOST [PORT]" >&2
  echo "  HOST   ssh target (e.g. ec2-user@1.2.3.4); default user is ec2-user" >&2
  echo "  PORT   service port (default: 3000)" >&2
  exit 1
}

[[ $# -ge 1 && $# -le 2 ]] || usage

HOST="$1"
PORT="${2:-3000}"

if [[ -z "${HOST}" ]]; then
  echo "Error: HOST is required." >&2
  usage
fi
if ! [[ "${PORT}" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
  echo "Error: PORT must be a number between 1 and 65535 (got '${PORT}')." >&2
  exit 1
fi

# Default to the Amazon Linux user if none was given.
if [[ "${HOST}" != *@* ]]; then
  HOST="ec2-user@${HOST}"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "${SCRIPT_DIR}")"

REMOTE_TARBALL="/tmp/secret-hitler.tar.gz"
REMOTE_APP_DIR="/opt/secret-hitler"

LOCAL_TMPDIR="$(mktemp -d -t secret-hitler.XXXXXX)"
LOCAL_TARBALL="${LOCAL_TMPDIR}/secret-hitler.tar.gz"
cleanup() { rm -rf "${LOCAL_TMPDIR}"; }
trap cleanup EXIT

echo "==> Packaging working tree from ${APP_DIR}"
tar --exclude='./.git' --exclude='./node_modules' --exclude='./.data' \
    --exclude='./.claude' --exclude='*.db' --exclude='*.db-wal' \
    --exclude='*.db-shm' --exclude='.DS_Store' \
    -czf "${LOCAL_TARBALL}" -C "${APP_DIR}" .

echo "==> Copying to ${HOST}:${REMOTE_TARBALL}"
scp "${LOCAL_TARBALL}" "${HOST}:${REMOTE_TARBALL}"

echo "==> Extracting and bootstrapping on ${HOST} (port ${PORT})"
ssh "${HOST}" "
  set -euo pipefail
  sudo mkdir -p '${REMOTE_APP_DIR}'
  sudo tar -xzf '${REMOTE_TARBALL}' -C '${REMOTE_APP_DIR}'
  sudo env PORT='${PORT}' bash '${REMOTE_APP_DIR}/deploy/setup.sh'
  rm -f '${REMOTE_TARBALL}'
"

echo
echo "==> Deployed. Service is live on ${HOST#*@} port ${PORT}."
echo "    Remember to open inbound TCP ${PORT} in the firewall / security group."
