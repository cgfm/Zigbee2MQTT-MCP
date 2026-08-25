# Changelog

All notable changes are documented here.

## 1.2.0 - 2026-08-25

- Migrated the maintained Home Assistant patches into regular TypeScript source on top of upstream commit `cb4c9eb4239330e164313844c6873821c39aeab7`.
- Added one validated configuration layer for environment variables and Home Assistant `/data/options.json`, with environment precedence and legacy token compatibility.
- Added secure Streamable HTTP, legacy SSE, Bearer authentication, timing-safe token checks, origin validation, rate limiting, request/session limits, optional TLS, and reduced health output.
- Added Zigbee2MQTT management tools, destructive-action gating and confirmation, writable-expose validation, transaction-matched bridge requests, timeouts, and pending-request limits.
- Preserved slash-containing friendly names, database migrations, stale-device removal, discovery, and secret redaction.
- Added a universal multi-stage Node 24.18.0 Alpine image for Docker and Home Assistant, plus Compose, tests, and release workflows for amd64 and arm64.

## 1.1.1

- Last Home Assistant wrapper release before the standalone repository migration.
