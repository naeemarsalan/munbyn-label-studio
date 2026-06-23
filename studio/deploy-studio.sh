#!/usr/bin/env bash
# Build the Munbyn Label Studio image natively on the Pi and push it to the registry.
# Run from your workstation; it ships the studio/ context over SSH and builds remotely
# (the Pi is ARM64, so building there avoids cross-arch hassle).
# App data (assets/templates/settings) persists in the "munbyn-data" Docker volume,
# so rebuilding and re-deploying the image never wipes saved work.
set -euo pipefail

HOST="${HOST:-anaeem@192.168.1.186}"
REMOTE_DIR="${REMOTE_DIR:-~/munbyn-studio}"
IMAGE="${IMAGE:-oci.arsalan.io/munbyn/label-studio:latest}"
REGISTRY="${REGISTRY:-oci.arsalan.io}"
REG_USER="${REG_USER:-admin}"
REG_PASS="${REG_PASS:?set REG_PASS env var = Harbor admin password}"

here="$(cd "$(dirname "$0")" && pwd)"

echo ">> shipping build context to ${HOST}:${REMOTE_DIR}"
ssh "$HOST" "rm -rf ${REMOTE_DIR} && mkdir -p ${REMOTE_DIR}"
# Ship the studio/ dir (Dockerfile + web/ + server/ + shared/). Skip node_modules,
# build output and macOS resource-fork files so the context stays small and clean.
tar -C "$here" \
  --exclude='._*' \
  --exclude='.DS_Store' \
  --exclude='web/node_modules' \
  --exclude='web/dist' \
  --exclude='server/node_modules' \
  -cf - Dockerfile web server shared \
  | ssh "$HOST" "tar -xf - -C ${REMOTE_DIR} && find ${REMOTE_DIR} -name '._*' -delete"

echo ">> building ${IMAGE} on ${HOST}"
ssh "$HOST" "cd ${REMOTE_DIR} && docker build -t ${IMAGE} ."

echo ">> logging in to ${REGISTRY} and pushing"
ssh "$HOST" "echo '${REG_PASS}' | docker login ${REGISTRY} -u ${REG_USER} --password-stdin && docker push ${IMAGE}"

echo ">> done. On the Pi:  cd ~/munbyn-cups && docker compose pull && docker compose up -d"
echo ">>   then open:       http://192.168.1.186:8080"
