#!/usr/bin/env bash
set -euo pipefail

transcript_path="${1:?missing transcript path}"
event_path="${2:?missing event path}"

mkdir -p "$(dirname "${transcript_path}")"
mkdir -p "$(dirname "${event_path}")"
touch "${transcript_path}" "${event_path}"

cleanup() {
  date -Is > "${event_path}" 2>/dev/null || true
}

trap cleanup EXIT

while IFS= read -r line || [[ -n "${line}" ]]; do
  printf '%s\n' "${line}" >> "${transcript_path}"
  date -Is > "${event_path}" 2>/dev/null || true
done
