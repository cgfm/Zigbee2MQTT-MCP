# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:24.18.0-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd

FROM ${NODE_IMAGE} AS builder
WORKDIR /app

RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
    && npm prune --omit=dev

FROM ${NODE_IMAGE} AS runtime
ARG BUILD_ARCH=amd64
ARG BUILD_VERSION=1.2.0

LABEL io.hass.version="${BUILD_VERSION}" \
      io.hass.type="app" \
      io.hass.arch="${BUILD_ARCH}" \
      org.opencontainers.image.title="Zigbee2MQTT-MCP" \
      org.opencontainers.image.description="Secure MCP server for Zigbee2MQTT" \
      org.opencontainers.image.source="https://github.com/cgfm/Zigbee2MQTT-MCP" \
      org.opencontainers.image.url="https://github.com/cgfm/Zigbee2MQTT-MCP" \
      org.opencontainers.image.documentation="https://github.com/cgfm/Zigbee2MQTT-MCP#readme" \
      org.opencontainers.image.version="${BUILD_VERSION}" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    DB_PATH=/data/mcp2zigbee2mqtt.db

WORKDIR /app
RUN mkdir -p /data \
    && chown node:node /data
COPY --from=builder --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist

# Home Assistant mounts /data with host-managed ownership, so the universal
# image keeps root as its default. Standalone deployments may set user: 1000:1000
# after making their /data volume writable by that UID.
EXPOSE 3235
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "dist/healthcheck.js"]
CMD ["node", "dist/index.js"]
