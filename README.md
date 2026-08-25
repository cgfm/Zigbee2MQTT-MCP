# Zigbee2MQTT-MCP

[![Release](https://img.shields.io/github/v/release/cgfm/Zigbee2MQTT-MCP?display_name=tag&sort=semver)](https://github.com/cgfm/Zigbee2MQTT-MCP/releases/latest)
[![CI](https://github.com/cgfm/Zigbee2MQTT-MCP/actions/workflows/pull-request.yml/badge.svg?branch=main)](https://github.com/cgfm/Zigbee2MQTT-MCP/actions/workflows/pull-request.yml)
[![GHCR image](https://img.shields.io/badge/GHCR-zigbee2mqtt--mcp-2496ED?logo=github)](https://github.com/cgfm/Zigbee2MQTT-MCP/pkgs/container/zigbee2mqtt-mcp)

Zigbee2MQTT-MCP exposes a Zigbee2MQTT installation as a secure Model Context Protocol (MCP) server. One TypeScript application and one OCI image support local Node.js use, ordinary Docker deployments, and the Home Assistant app.

The server provides Streamable HTTP at `/mcp`, legacy SSE at `/sse` with messages posted to `/messages`, and stdio transport. HTTP transport requires a Bearer token. It also enforces origin, request-size, authentication-rate, session, MQTT-message, and pending-bridge-request limits.

This project is derived from [ichbinder/MCP2ZigBee2MQTT](https://github.com/ichbinder/MCP2ZigBee2MQTT). See [UPSTREAM.md](UPSTREAM.md) for the exact base commit and migration history.

## Local installation

Requirements:

- Node.js 24.18.0 (Node 24.19.0 is intentionally avoided because of a native cleanup regression)
- npm
- a reachable MQTT broker used by Zigbee2MQTT

```sh
git clone https://github.com/cgfm/Zigbee2MQTT-MCP.git
cd Zigbee2MQTT-MCP
npm ci
npm run build
cp .env.example .env
```

Export the settings from `.env` with your preferred environment loader, then run `npm start`. `npm run dev` builds and starts a watched Node process; `npm run watch` only watches the TypeScript compiler.

For stdio clients, set `TRANSPORT_MODE=stdio`. HTTP mode requires `API_KEY` with at least 24 header-safe characters.

## Docker Compose

```sh
cp .env.example .env
# Edit .env and replace API_KEY and broker settings.
docker compose up -d
```

The published image is `ghcr.io/cgfm/zigbee2mqtt-mcp:1.2.0`. Application state is stored at `/data/mcp2zigbee2mqtt.db`; TLS certificates can be mounted read-only under `/ssl`. The image uses a pinned Node 24.18.0 Alpine multi-architecture manifest and supports `linux/amd64` and `linux/arm64`.

The default image user remains root because Home Assistant owns the `/data` mount. Standalone deployments can set `user: "1000:1000"` after making the mounted data directory writable by that UID.

## Home Assistant

The Home Assistant catalog remains [cgfm/HASS-AddOns](https://github.com/cgfm/HASS-AddOns). Add that repository to the Home Assistant app store, install **Zigbee2MQTT-MCP**, configure MQTT and a Bearer token, then start it. Existing installations keep the slug `mcp2zigbee2mqtt`, port `3235`, option names, database, and legacy generated token compatibility.

When `/data/options.json` exists, the application reads Home Assistant options directly. Explicit environment variables take precedence. No Bashio or s6 startup wrapper is required; Home Assistant runs the same image as Docker users.

## MCP client configuration

For Streamable HTTP, configure a client with:

```json
{
  "mcpServers": {
    "zigbee2mqtt": {
      "type": "http",
      "url": "http://home-assistant.local:3235/mcp",
      "headers": {
        "Authorization": "Bearer REPLACE_WITH_YOUR_TOKEN"
      }
    }
  }
}
```

Legacy clients may use `http://home-assistant.local:3235/sse` with the same Authorization header. Browser-based clients must also have their exact origin listed in `ALLOWED_ORIGINS` or the Home Assistant `allowed_origins` option.

For local stdio:

```json
{
  "mcpServers": {
    "zigbee2mqtt": {
      "command": "node",
      "args": ["/absolute/path/Zigbee2MQTT-MCP/dist/index.js"],
      "env": {
        "TRANSPORT_MODE": "stdio",
        "MQTT_BROKER_URL": "mqtt://127.0.0.1:1883",
        "MQTT_BASE_TOPIC": "zigbee2mqtt"
      }
    }
  }
}
```

## Configuration

| Environment variable | Home Assistant option | Default |
| --- | --- | --- |
| `MQTT_BROKER_URL` | `mqtt_broker_url` | `mqtt://localhost:1883` |
| `MQTT_USERNAME` | `mqtt_username` | empty |
| `MQTT_PASSWORD` | `mqtt_password` | empty |
| `MQTT_BASE_TOPIC` | `mqtt_base_topic` | `zigbee2mqtt` |
| `TRANSPORT_MODE` | `transport_mode` | `stdio` (`http` in the HA catalog) |
| `API_KEY` | `api_key` | required for HTTP |
| `ALLOWED_ORIGINS` | `allowed_origins` | empty; requests with Origin are denied |
| `SSL_ENABLED` | `ssl` | `false` |
| `SSL_CERTFILE` | `certfile` under `/ssl` | `/ssl/fullchain.pem` |
| `SSL_KEYFILE` | `keyfile` under `/ssl` | `/ssl/privkey.pem` |
| `MAX_SESSIONS` | `max_sessions` | `32` (range 1–128) |
| `ALLOW_DESTRUCTIVE` | `allow_destructive` | `false` |
| `LOG_LEVEL` | `log_level` | `info` |
| `DB_PATH` | — | local `./zigbee2mqtt.db`; image `/data/mcp2zigbee2mqtt.db` |

Secrets are never included in startup logs. MQTT URLs and retained bridge data returned by management tools are redacted.

## Tools and safety

The server retains all discovery, state, documentation, and device-control tools from upstream and adds read-only bridge information plus Zigbee2MQTT group, binding, device, OTA, network-map, health, coordinator, restart, and permit-join management tools.

Management writes are hidden unless `ALLOW_DESTRUCTIVE=true`. Irreversible operations (`delete_group`, `clear_binds`, `remove_device`, and `restart_zigbee2mqtt`) additionally require `confirm=true`. Device commands are checked against writable Zigbee2MQTT exposes and their type/range/enum constraints.

Do not expose plaintext HTTP directly to an untrusted network. Enable TLS or place the service behind an HTTPS reverse proxy.

## Development

```sh
npm ci
npm test
docker build --build-arg BUILD_ARCH=amd64 --build-arg BUILD_VERSION=1.2.0 -t zigbee2mqtt-mcp:dev .
npm run test:container
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the complete validation checklist.

## License

MIT. The original license and attribution are preserved in [LICENSE](LICENSE); provenance is documented in [UPSTREAM.md](UPSTREAM.md).
