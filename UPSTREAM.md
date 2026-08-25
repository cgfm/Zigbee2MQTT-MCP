# Upstream provenance

- Original repository: [ichbinder/MCP2ZigBee2MQTT](https://github.com/ichbinder/MCP2ZigBee2MQTT)
- Original license: MIT, preserved in `LICENSE`
- Base commit: `cb4c9eb4239330e164313844c6873821c39aeab7`
- Fork date: 2026-08-25

## Why this project diverged

Zigbee2MQTT-MCP was split out of the `cgfm/HASS-AddOns` catalog so that its security, transport, MQTT-management, database, and container behavior can be maintained and tested as a normal TypeScript project. The Home Assistant entry is now intended to be a thin catalog wrapper around the same OCI image used by standalone Docker deployments.

## Imported local changes

The migration applied the former catalog patches in order and then imported its lockfile:

1. `0001-addon-runtime-fixes.patch`: pinned dependencies, SQLite uniqueness repair, correct legacy SSE message routing, full-topic subscriptions, and friendly names containing `/`.
2. `0002-security-and-management.patch`: Streamable HTTP, authentication and limits, optional TLS, redaction, stale-device removal, expose access metadata and command validation, management tools, destructive-operation controls, and transaction-based Zigbee2MQTT bridge requests.
3. The `package-lock.json` formerly maintained by the Home Assistant wrapper.

Those changes are committed as ordinary source. This repository does not apply build-time source patches.

The standalone migration additionally introduced centralized Home Assistant/environment configuration, graceful lifecycle handling, a shared package/server version, a universal image, automated security/transport tests, and release automation.

## Comparing with upstream

Add the source repository as an `upstream` remote and fetch it without rewriting local history:

```sh
git remote add upstream https://github.com/ichbinder/MCP2ZigBee2MQTT.git
git fetch upstream
git log --left-right --cherry-pick cb4c9eb4239330e164313844c6873821c39aeab7...upstream/main
git diff cb4c9eb4239330e164313844c6873821c39aeab7..upstream/main -- src package.json
```

Review and port upstream changes in small, attributable pull requests. Do not reintroduce the old build-patch mechanism, and rerun all transport, security, MQTT, database, and container tests after every comparison.
