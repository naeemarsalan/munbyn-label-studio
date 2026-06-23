# Munbyn ITPP941 label printer — CUPS server in a container.
# The printer speaks ZPL; the macOS "driver" is just stock CUPS rastertolabel +
# a PPD, and Debian 13 ships that same filter in the `cups` package. So this
# image is plain CUPS + the adapted PPD (cupsModelNumber 18 = ZEBRA_ZPL).
#
# Build natively on the target (Raspberry Pi / arm64); see deploy.sh.
FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      cups \
      cups-client \
      cups-filters \
      ghostscript \
      usbutils \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /etc/cups/cupsd.conf

# Adapted PPD + LAN-accessible server config + startup logic.
COPY ppd/Munbyn_ITPP941_linux.ppd /usr/share/cups/model/Munbyn_ITPP941_linux.ppd
COPY cups/cupsd.conf               /etc/cups/cupsd.conf
COPY docker-entrypoint.sh          /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 631

# Web UI / IPP health
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD lpstat -r >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
