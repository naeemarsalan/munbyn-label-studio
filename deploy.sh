#!/usr/bin/env bash
# Build the Munbyn CUPS image natively on the Pi and push it to oci.arsalan.io.
# Run from your workstation; it ships the context over SSH and builds remotely
# (the Pi is ARM64, so building there avoids cross-arch hassle).
set -euo pipefail

HOST="${HOST:-anaeem@192.168.1.186}"
REMOTE_DIR="${REMOTE_DIR:-~/munbyn-cups}"
IMAGE="${IMAGE:-oci.arsalan.io/munbyn/cups-itpp941:latest}"
REGISTRY="${REGISTRY:-oci.arsalan.io}"
REG_USER="${REG_USER:-admin}"
REG_PASS="${REG_PASS:?set REG_PASS env var = Harbor admin password}"

here="$(cd "$(dirname "$0")" && pwd)"

echo ">> shipping build context to ${HOST}:${REMOTE_DIR}"
ssh "$HOST" "rm -rf ${REMOTE_DIR} && mkdir -p ${REMOTE_DIR}"
tar -C "$here" -cf - Dockerfile docker-compose.yml docker-entrypoint.sh ppd cups \
  | ssh "$HOST" "tar -xf - -C ${REMOTE_DIR} && find ${REMOTE_DIR} -name '._*' -delete"

echo ">> building ${IMAGE} on ${HOST}"
ssh "$HOST" "cd ${REMOTE_DIR} && docker build -t ${IMAGE} ."

echo ">> logging in to ${REGISTRY} and pushing"
ssh "$HOST" "echo '${REG_PASS}' | docker login ${REGISTRY} -u ${REG_USER} --password-stdin && docker push ${IMAGE}"

echo ">> done. On the Pi:  cd ${REMOTE_DIR} && docker compose up -d"
