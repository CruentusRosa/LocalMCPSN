#!/usr/bin/env sh
# Starts the server with credentials loaded from a .env file, so Codex's
# config.toml only needs:  command = "/abs/path/bin/run-with-env.sh"
# Usage: run-with-env.sh [path/to/.env]   (defaults to <repo>/.env)
set -eu
HERE="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${1:-$HERE/.env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi
exec node "$HERE/server.mjs"
