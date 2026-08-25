# Contributing

Contributions should be narrowly scoped and retain upstream attribution. Never commit MQTT credentials, Bearer tokens, broker addresses from a private network, Zigbee network keys, or production device data.

Use Node.js 24.18.0 and install exactly the locked dependencies:

```sh
npm ci
npm test
git diff --check
docker build --build-arg BUILD_ARCH=amd64 --build-arg BUILD_VERSION=1.2.0 -t zigbee2mqtt-mcp:dev .
```

Runtime or transport changes must also pass `npm run test:container`, which uses an isolated MQTT broker and disposable Docker network. Confirm `/health`, `/mcp`, `/sse`, authentication, Origin checks, session and request limits, graceful shutdown, and absence of `RemoveEnvironmentCleanupHook`, exit 134, or secret leakage.

Pull requests should explain the user-visible effect, list commands and architectures tested, and call out security or migration implications. Release changes must update `CHANGELOG.md`; package, server, image, Git tag, and release versions must agree.

Management writes require explicit `allow_destructive`. Irreversible actions must continue to require `confirm=true`; tests must never target production Zigbee devices.
