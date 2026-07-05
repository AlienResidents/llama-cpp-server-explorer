#!/usr/bin/env bash
#
# Install llama-cpp-server-explorer to a per-platform default location, or to
# a path passed as the first argument. Downloads a tarball of `main` (no .git),
# syncs it into the install dir (deleting stale files from prior installs),
# runs `pnpm install` and `pnpm build`. Re-run to update.
#
# Usage:
#   ./install.bash                       # default location
#   ./install.bash /custom/path          # custom location
#   curl -fsSL <url>/install.bash | bash # default location
#   curl -fsSL <url>/install.bash | bash -s -- /custom/path
#
set -euo pipefail

REPO_OWNER="AlienResidents"
REPO_NAME="llama-cpp-server-explorer"
BRANCH="${BRANCH:-main}"
TARBALL_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}/archive/refs/heads/${BRANCH}.tar.gz"

# ─── Resolve install dir ───────────────────────────────────────────────────

INSTALL_DIR="${1:-}"
if [[ -z "${INSTALL_DIR}" ]]; then
  os="$(uname -s)"
  case "${os}" in
    Darwin)
      INSTALL_DIR="${HOME}/Developer/${REPO_NAME}"
      ;;
    Linux)
      INSTALL_DIR="${XDG_DATA_HOME:-${HOME}/.local/share}/${REPO_NAME}"
      ;;
    *)
      echo "ERROR: unsupported OS '${os}'. Pass an install dir explicitly:" >&2
      echo "    $0 /path/to/install" >&2
      exit 1
      ;;
  esac
fi

echo "==> Installing to: ${INSTALL_DIR}"

# ─── Pre-flight: required tools ────────────────────────────────────────────

require() {
  local cmd="$1"
  local hint="$2"
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "ERROR: '${cmd}' is required but not on PATH." >&2
    echo "       ${hint}" >&2
    exit 1
  fi
}
require curl  "Install via your package manager (apt/brew/pacman/...)."
require tar   "Standard on macOS and Linux; should already be present."
require node  "Install Node.js 22.12+ via nvm/fnm/Homebrew/nodejs.org."
require pnpm  "Install via 'corepack enable && corepack prepare pnpm@latest --activate' or 'npm i -g pnpm'."
require rsync "Standard on macOS and Linux. If missing: apt install rsync / brew install rsync."

# ─── Fetch + extract into a staging dir ────────────────────────────────────
#
# We extract the tarball into a temp staging dir first, then rsync it into
# the install dir with --delete. This removes files that were deleted from
# the repo between releases (a bare tar -xzf only adds/overwrites; it never
# deletes). We exclude data/ (the SQLite cache), node_modules/ (regenerated
# by pnpm install), and .git/ (in case the install dir is a dev clone).

mkdir -p "${INSTALL_DIR}"
TMP_TAR="$(mktemp -t llama-explorer-XXXXXX.tar.gz)"
TMP_STAGE="$(mktemp -d -t llama-explorer-staging-XXXXXX)"
trap 'rm -f "${TMP_TAR}"; rm -rf "${TMP_STAGE}"' EXIT

echo "==> Downloading ${TARBALL_URL}"
curl -fsSL --max-time 60 -o "${TMP_TAR}" "${TARBALL_URL}"

echo "==> Extracting into staging dir"
tar -xzf "${TMP_TAR}" -C "${TMP_STAGE}"
# Tarball contains a single top-level dir like
# llama-cpp-server-explorer-main/. Find it.
STAGED="$(find "${TMP_STAGE}" -mindepth 1 -maxdepth 1 -type d | head -1)"
if [[ -z "${STAGED}" ]]; then
  echo "ERROR: tarball did not produce an expected top-level directory." >&2
  exit 1
fi

echo "==> Syncing into ${INSTALL_DIR}"
rsync -a --delete \
  --exclude='/data' \
  --exclude='/node_modules' \
  --exclude='/.git' \
  "${STAGED}/" "${INSTALL_DIR}/"

# ─── Build ────────────────────────────────────────────────────────────────

cd "${INSTALL_DIR}"
echo "==> pnpm install"
pnpm install --frozen-lockfile
echo "==> pnpm build"
pnpm build

# ─── Done ─────────────────────────────────────────────────────────────────

cat <<EOF

✓ Installed to: ${INSTALL_DIR}

Run with:
    cd "${INSTALL_DIR}"
    pnpm start

Then open http://localhost:8787 in your browser.

Re-run this script to update — the install dir is synced in place,
your cache (data/explorer.db) is preserved.
EOF
