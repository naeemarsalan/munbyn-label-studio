#!/usr/bin/env bash
# Entrypoint for the Munbyn ITPP941 CUPS container.
#   1. create an admin user for the CUPS web UI
#   2. launch cupsd (foreground, as a child we can signal)
#   3. auto-detect the Munbyn USB printer (or use $PRINTER_URI) and create the queue
#   4. wait on cupsd, forwarding TERM/INT so `docker stop` is clean
set -euo pipefail

ADMIN_USER="${CUPS_ADMIN_USER:-admin}"
ADMIN_PASS="${CUPS_ADMIN_PASSWORD:-admin}"
QUEUE="${PRINTER_QUEUE:-Munbyn_ITPP941}"
PPD="/usr/share/cups/model/Munbyn_ITPP941_linux.ppd"
PRINTER_INFO="${PRINTER_INFO:-Munbyn ITPP941}"
PRINTER_LOCATION="${PRINTER_LOCATION:-$(hostname)}"

log() { echo "[entrypoint] $*"; }

# --- 1. admin user for the web UI ----------------------------------------
if ! id "$ADMIN_USER" >/dev/null 2>&1; then
  useradd -r -M -s /usr/sbin/nologin -G lpadmin "$ADMIN_USER"
  log "created CUPS admin user '$ADMIN_USER' (group lpadmin)"
fi
echo "${ADMIN_USER}:${ADMIN_PASS}" | chpasswd
mkdir -p /run/cups /var/spool/cups

# --- 2. launch cupsd as a signal-forwardable child -----------------------
log "starting cupsd…"
/usr/sbin/cupsd -f &
CUPSD_PID=$!
trap 'log "stopping cupsd"; kill -TERM "$CUPSD_PID" 2>/dev/null || true' TERM INT

for _ in $(seq 1 40); do
  lpstat -r >/dev/null 2>&1 && break
  sleep 0.25
done
if ! lpstat -r >/dev/null 2>&1; then
  log "ERROR: cupsd did not become responsive"; exit 1
fi
log "cupsd is up."

# --- 3. find the printer and create the queue ----------------------------
URI="${PRINTER_URI:-}"
if [ -z "$URI" ]; then
  log "searching for a Munbyn USB printer (lpinfo -v)…"
  URI="$(lpinfo -v 2>/dev/null | awk '/usb:/ && (/[Mm]unbyn/ || /ITPP/) {print $2; exit}')"
fi
if [ -z "$URI" ]; then
  # only one USB printer attached? use it.
  CANDIDATES="$(lpinfo -v 2>/dev/null | awk '/^direct usb:/ {print $2}')"
  if [ "$(printf '%s\n' "$CANDIDATES" | grep -c .)" = "1" ]; then
    URI="$CANDIDATES"
    log "no name match; using the only USB printer present: $URI"
  fi
fi

if [ -n "$URI" ]; then
  log "configuring queue '$QUEUE' -> $URI"
  lpadmin -p "$QUEUE" -E -v "$URI" -P "$PPD" \
          -D "$PRINTER_INFO" -L "$PRINTER_LOCATION" \
          -o printer-is-shared=true
  cupsenable "$QUEUE" 2>/dev/null || true
  cupsaccept "$QUEUE" 2>/dev/null || true
  lpadmin -d "$QUEUE" 2>/dev/null || true
  log "queue '$QUEUE' ready (default). Test: lp -d $QUEUE <file>"
else
  log "------------------------------------------------------------------"
  log "NO USB PRINTER DETECTED."
  log "Plug the Munbyn ITPP941 into THIS host's USB, then restart the"
  log "container (docker restart $(hostname)) or add it from the web UI."
  log "------------------------------------------------------------------"
fi

log "CUPS web UI:  http://<host-ip>:631/    (login user: ${ADMIN_USER})"

# --- 4. hand control to cupsd --------------------------------------------
wait "$CUPSD_PID"
