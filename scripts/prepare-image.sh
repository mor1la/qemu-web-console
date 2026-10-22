#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="$ROOT/data"
BASE="debian-13-genericcloud-amd64-20261001-2618.qcow2"
URL="https://cloud.debian.org/images/cloud/trixie/20261001-2618/$BASE"
SHA512_BASE64="9G8GcablvexSkauJcrri8Q5UCML2SnQHjxHvwvBqQ2qdAxPtUOBHJULuq/eA6ffHkqwKMUxsIFB/zZ/YG0aMPQ=="

# Load VM user settings from .env
if [[ -f "$ROOT/.env" ]]; then
  source "$ROOT/.env"
fi

VM_USER="${VM_USER:-debian}"
: "${VM_PASSWORD:?Set VM_PASSWORD in .env before preparing the image}"

if [[ ! "$VM_USER" =~ ^[a-z_][a-z0-9_-]*$ ]]; then
  echo "Invalid VM_USER: use lowercase letters, digits, _ or -" >&2
  exit 1
fi

for cmd in curl qemu-img cloud-localds ssh-keygen python3 openssl; do
  command -v "$cmd" >/dev/null || { echo "Missing: $cmd" >&2; exit 1; }
done

# Generate password hash
PASSWORD_HASH="$(printf '%s\n' "$VM_PASSWORD" | openssl passwd -6 -stdin)"
unset VM_PASSWORD

mkdir -p "$DATA/keys" "$DATA/run"
chmod 700 "$DATA" "$DATA/keys" "$DATA/run"

if [[ ! -f "$DATA/keys/id_ed25519" ]]; then
  ssh-keygen -q -t ed25519 -N '' -f "$DATA/keys/id_ed25519"
fi

chmod 600 "$DATA/keys/id_ed25519"

# Download Debian image
if [[ ! -f "$DATA/$BASE" ]]; then
  curl -fL --retry 3 "$URL" -o "$DATA/$BASE.part"
  mv "$DATA/$BASE.part" "$DATA/$BASE"
fi

# Verify SHA512
python3 - "$DATA/$BASE" "$SHA512_BASE64" <<'PYVERIFY'
import base64
import hashlib
import sys

path, expected = sys.argv[1:]
h = hashlib.sha512()

with open(path, 'rb') as f:
    for chunk in iter(lambda: f.read(1024 * 1024), b''):
        h.update(chunk)

if h.digest() != base64.b64decode(expected):
    sys.exit('ERROR: Debian image SHA512 mismatch')

print('Debian cloud image SHA512 verified')
PYVERIFY

# Create VM disk
if [[ -e "$DATA/debian.qcow2" ]]; then
  echo "Existing VM disk; skipping disk creation"
  echo "Note: changed .env credentials will NOT update users in the existing VM"
else
  qemu-img create -f qcow2 -F qcow2 -b "$BASE" "$DATA/debian.qcow2" 20G
fi

PUBKEY="$(cat "$DATA/keys/id_ed25519.pub")"

# Generate cloud-init configuration
touch "$DATA/user-data"
chmod 600 "$DATA/user-data"

cat > "$DATA/user-data" <<EOF
#cloud-config
hostname: debian-vm
manage_etc_hosts: true

users:
  - name: ${VM_USER}
    gecos: Debian VM user
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL
    lock_passwd: false
    passwd: '${PASSWORD_HASH}'
    ssh_authorized_keys:
      - ${PUBKEY}

ssh_pwauth: false
disable_root: true

packages:
  - openssh-server

runcmd:
  - [ systemctl, enable, --now, ssh ]
  - [ systemctl, enable, --now, serial-getty@ttyS0.service ]
EOF

# Generate instance metadata
cat > "$DATA/meta-data" <<EOF
instance-id: debian13-qemu-web-01
local-hostname: debian-vm
EOF

# Create cloud-init ISO
cloud-localds "$DATA/seed.iso" "$DATA/user-data" "$DATA/meta-data"

chmod 600 "$DATA/user-data" "$DATA/seed.iso"

echo "Created $DATA/debian.qcow2 and seed.iso"
echo "VM user: $VM_USER"
echo "SSH key: $DATA/keys/id_ed25519"