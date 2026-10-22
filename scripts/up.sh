#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -f data/debian.qcow2 || ! -f data/seed.iso ]]; then
  echo "First run scripts/prepare-image.sh" >&2
  exit 1
fi

docker compose up -d --build