#!/usr/bin/env bash
#
# frieren.sh — task runner for the Claude Motion project.
#
# Usage:
#   ./frieren.sh microservice run [name]   Run a microservice (default: rotoscoping)
#   ./frieren.sh microservice list         List available microservices
#   ./frieren.sh help                      Show this help
#
set -euo pipefail

# Repo root = directory this script lives in, regardless of where it's invoked from.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICES_DIR="$ROOT/microservices"

die() { echo "frieren: $*" >&2; exit 1; }

list_services() {
  [ -d "$SERVICES_DIR" ] || return 0
  for d in "$SERVICES_DIR"/*/; do
    [ -d "$d" ] || continue
    basename "$d"
  done
}

usage() {
  cat <<'EOF'
frieren — Claude Motion task runner

Usage:
  ./frieren.sh microservice run [name]   Run a microservice (default: rotoscoping)
  ./frieren.sh microservice list         List available microservices
  ./frieren.sh help                      Show this help
EOF
}

cmd_microservice() {
  local action="${1:-}"
  case "$action" in
    run)
      shift || true
      local name="${1:-rotoscoping}"
      local dir="$SERVICES_DIR/$name"
      [ -d "$dir" ] || die "no such microservice: '$name' (try: ./frieren.sh microservice list)"
      command -v uv >/dev/null 2>&1 || die "uv is not installed — see https://docs.astral.sh/uv/"
      [ -f "$dir/main.py" ] || die "microservice '$name' has no main.py at $dir"
      echo "frieren: starting '$name' microservice (uv run main.py)…"
      cd "$dir"
      # Enable uv's extra-build-dependencies (preview in uv 0.9.x); the
      # rotoscoping service relies on it to inject setuptools/wheel into SAM2's
      # build env. Appended so a caller-set value is preserved.
      export UV_PREVIEW_FEATURES="${UV_PREVIEW_FEATURES:+$UV_PREVIEW_FEATURES,}extra-build-dependencies"
      exec uv run main.py
      ;;
    list)
      local found=0
      while IFS= read -r s; do
        [ -n "$s" ] || continue
        echo "$s"
        found=1
      done < <(list_services)
      [ "$found" -eq 1 ] || echo "(no microservices found under $SERVICES_DIR)"
      ;;
    ""|help|-h|--help)
      echo "Usage: ./frieren.sh microservice {run [name]|list}"
      ;;
    *)
      die "unknown microservice action: '$action' (expected: run, list)"
      ;;
  esac
}

main() {
  local group="${1:-help}"
  case "$group" in
    microservice|service|svc)
      shift
      cmd_microservice "$@"
      ;;
    help|-h|--help|"")
      usage
      ;;
    *)
      die "unknown command: '$group' (try: ./frieren.sh help)"
      ;;
  esac
}

main "$@"
