#!/usr/bin/env bash

set -Eeuo pipefail

readonly PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly MODE="${1:-all}"

cd "$PROJECT_ROOT"

log() {
  printf '\n[guardian] %s\n' "$1"
}

require_dependencies() {
  if [[ ! -d node_modules ]]; then
    printf '[guardian] Dependencies are missing. Run npm install first.\n' >&2
    exit 1
  fi
}

run_quality_guardian() {
  log "Quality guardian: lint, size limits, and type safety"
  npm run lint
  npm run typecheck
}

run_functionality_guardian() {
  log "Functionality guardian: tests and production build"
  npm run test --if-present
  npm run build -- --webpack
}

show_usage() {
  printf 'Usage: %s [all|quality|functionality]\n' "${0##*/}"
}

require_dependencies

case "$MODE" in
  all)
    run_quality_guardian
    run_functionality_guardian
    ;;
  quality)
    run_quality_guardian
    ;;
  functionality)
    run_functionality_guardian
    ;;
  *)
    show_usage >&2
    exit 2
    ;;
esac

log "All requested checks passed"
