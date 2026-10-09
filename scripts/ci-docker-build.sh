#!/usr/bin/env bash
# Retry only Docker Hub metadata/token transport failures in GitHub CI.
# Never mask actual Dockerfile or application build failures.
set -euo pipefail
if [[ "$#" -ne 2 ]]; then
  echo "Expected Dockerfile and CI image tag." >&2
  exit 2
fi
case "$1:$2" in
  Dockerfile.relay:tetherplane-relay:ci|Dockerfile.auth:tetherplane-auth:ci) ;;
  *) echo "Unknown CI Docker build target." >&2; exit 2 ;;
esac

dockerfile="$1"
image_tag="$2"
output="$(mktemp)"
trap 'rm -f "$output"' EXIT

for attempt in 1 2 3; do
  if docker build --file "$dockerfile" --tag "$image_tag" . >"$output" 2>&1; then
    cat "$output"
    exit 0
  fi
  # Only metadata HTTP 429 and Docker Hub OAuth token HTTP 504 are transient.
  if grep -Eiq '(registry-1[.]docker[.]io.*429 Too Many Requests|failed to fetch oauth token.*504 Gateway Timeout|docker[.]io.*429 Too Many Requests)' "$output"; then
    if [[ "$attempt" -eq 3 ]]; then
      echo "Docker Hub transient error persisted after three attempts." >&2
      tail -n 75 "$output" >&2
      exit 1
    fi
    delay=$((attempt * 20))
    printf 'Docker Hub temporary 429/504 response (attempt %s/3); retrying in %ss.\n' "$attempt" "$delay" >&2
    sleep "$delay"
  else
    # Unexpected compiler, Dockerfile or image failures are not retried.
    tail -n 75 "$output" >&2
    exit 1
  fi
done
exit 1
