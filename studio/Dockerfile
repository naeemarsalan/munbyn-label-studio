# Munbyn Label Studio — multi-stage arm64 image.
# Build context MUST be the studio/ directory so web/, server/ and shared/ are available.
#
#   docker build -t oci.arsalan.io/munbyn/label-studio:latest .
#
# Runtime layout inside the image:
#   /app/server      server code + node_modules   (cwd at start)
#   /app/shared      shared/presets.ts            ('../../shared/presets' from /app/server/src)
#   /app/web/dist    built SPA                     (WEB_DIST)

# ---- Stage 1: build the SPA --------------------------------------------------
FROM node:20-slim AS webbuild
WORKDIR /app
COPY web ./web
COPY shared ./shared
RUN cd web && npm install && npm run build

# ---- Stage 2: runtime --------------------------------------------------------
FROM node:20-slim
WORKDIR /app
COPY server ./server
COPY shared ./shared
RUN cd server && npm install
COPY --from=webbuild /app/web/dist ./web/dist
# Persistence dir: assets, templates and settings are stored under DATA_DIR.
# Mount a named volume here in compose so data survives container rebuilds.
RUN mkdir -p /data
ENV WEB_DIST=/app/web/dist \
    PORT=8080 \
    PRINTER_DEVICE=/dev/usb/lp0 \
    DATA_DIR=/data
EXPOSE 8080
WORKDIR /app/server
CMD ["npm","start"]
