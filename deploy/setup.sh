#!/usr/bin/env bash
set -euo pipefail

# ── Secret Hitler — server-side deploy / bootstrap ─────────────────────────
# Run this ON the instance, as root, from inside the extracted app directory:
#
#   sudo bash /opt/secret-hitler/deploy/setup.sh
#
# It is idempotent — re-run it after copying new code to pick up an update.
# Steps: ensure Node >= 22.5 (needed for the built-in node:sqlite), create a
# locked-down service user, install prod deps, and register + start a systemd
# service that survives reboots and crashes.

NODE_VERSION="22.12.0"          # any >= 22.5 works; this is a current 22 LTS
SERVICE_USER="secrethitler"
SERVICE_NAME="secret-hitler"
PORT="${PORT:-3000}"            # override: PORT=80 sudo -E bash deploy/setup.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "${SCRIPT_DIR}")"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Please run as root, e.g.  sudo bash $0" >&2
  exit 1
fi

# 1. Ensure Node >= 22.5 ────────────────────────────────────────────────────
need_node=1
if command -v node >/dev/null 2>&1; then
  ver="$(node -p 'process.versions.node')"
  major="${ver%%.*}"; rest="${ver#*.}"; minor="${rest%%.*}"
  if (( major > 22 )) || { (( major == 22 )) && (( minor >= 5 )); }; then
    need_node=0
    echo "Found Node v${ver} (ok)."
  else
    echo "Node v${ver} is too old (< 22.5); installing v${NODE_VERSION}."
  fi
else
  echo "Node not found; installing v${NODE_VERSION}."
fi

if [[ "${need_node}" -eq 1 ]]; then
  case "$(uname -m)" in
    x86_64|amd64)  arch="x64"   ;;
    aarch64|arm64) arch="arm64" ;;
    *) echo "Unsupported CPU arch: $(uname -m)" >&2; exit 1 ;;
  esac
  tarball="node-v${NODE_VERSION}-linux-${arch}.tar.gz"
  url="https://nodejs.org/dist/v${NODE_VERSION}/${tarball}"
  tmp="$(mktemp -d)"
  echo "Downloading ${url}"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "${url}" -o "${tmp}/${tarball}"
  else
    wget -qO "${tmp}/${tarball}" "${url}"
  fi
  # Installs node + npm into /usr/local/{bin,lib,...}
  tar -xzf "${tmp}/${tarball}" -C /usr/local --strip-components=1
  rm -rf "${tmp}"
  echo "Installed $(node -v) to /usr/local/bin/node"
fi

export PATH="/usr/local/bin:${PATH}"
NODE_BIN="$(command -v node)"

# node:sqlite is gated behind --experimental-sqlite on some releases (e.g.
# 22.12) and unflagged on others. Probe this Node and only pass the flag if
# it is actually required, so the unit works across versions.
SQLITE_FLAG=""
if ! node -e 'require("node:sqlite")' >/dev/null 2>&1; then
  if node --experimental-sqlite -e 'require("node:sqlite")' >/dev/null 2>&1; then
    SQLITE_FLAG="--experimental-sqlite"
  else
    echo "Error: Node v$(node -p 'process.versions.node') cannot load node:sqlite." >&2
    echo "Upgrade to Node >= 22.5 (re-run with the bundled installer)." >&2
    exit 1
  fi
fi

# 2. Locked-down service user (no shell, no home) ───────────────────────────
if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin "${SERVICE_USER}"
  echo "Created service user ${SERVICE_USER}."
fi

# 3. Install production dependencies (just express) ─────────────────────────
cd "${APP_DIR}"
if [[ -f package-lock.json ]]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi

# 4. Writable data dir for the SQLite db (kept out of the code tree) ─────────
# server.js auto-uses ./.data when it exists, so code can stay read-only.
mkdir -p "${APP_DIR}/.data"
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${APP_DIR}/.data"

# 5. systemd unit ───────────────────────────────────────────────────────────
# Only grant the bind-low-ports capability when actually using a port < 1024.
CAP_LINE=""
if [[ "${PORT}" -lt 1024 ]]; then
  CAP_LINE="AmbientCapabilities=CAP_NET_BIND_SERVICE"
fi

cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Secret Hitler role assignment app
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${APP_DIR}
ExecStart=${NODE_BIN} ${SQLITE_FLAG} server.js
Environment=NODE_ENV=production
Environment=PORT=${PORT}
Restart=on-failure
RestartSec=5

# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${APP_DIR}/.data
${CAP_LINE}

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}.service"

echo
echo "Done. Service '${SERVICE_NAME}' is enabled and running on port ${PORT}."
echo "  Status:  systemctl status ${SERVICE_NAME}"
echo "  Logs:    journalctl -u ${SERVICE_NAME} -f"
echo "  Restart: systemctl restart ${SERVICE_NAME}"
systemctl --no-pager --lines=0 status "${SERVICE_NAME}.service" || true
