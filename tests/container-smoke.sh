#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME=${IMAGE_NAME:-zigbee2mqtt-mcp:dev}
TEST_ID="z2m-mcp-smoke-$$"
NETWORK_NAME="${TEST_ID}-net"
BROKER_NAME="${TEST_ID}-broker"
APP_NAME="${TEST_ID}-app"
TEST_TOKEN="container-test-token-at-least-24-chars"
TEST_TMP=$(mktemp -d /tmp/zigbee2mqtt-mcp-smoke.XXXXXX)

cleanup() {
    docker stop "${APP_NAME}" >/dev/null 2>&1 || true
    docker stop "${BROKER_NAME}" >/dev/null 2>&1 || true
    docker rm "${APP_NAME}" >/dev/null 2>&1 || true
    docker rm "${BROKER_NAME}" >/dev/null 2>&1 || true
    docker network rm "${NETWORK_NAME}" >/dev/null 2>&1 || true
    rm -r "${TEST_TMP}"
}
trap cleanup EXIT

docker build \
    --build-arg BUILD_ARCH=amd64 \
    --build-arg BUILD_VERSION=1.2.0 \
    --tag "${IMAGE_NAME}" .
docker network create "${NETWORK_NAME}" >/dev/null
docker run --detach \
    --name "${BROKER_NAME}" \
    --network "${NETWORK_NAME}" \
    --volume "${PWD}/tests/mosquitto.conf:/mosquitto/config/mosquitto.conf:ro" \
    eclipse-mosquitto:2.0.22 >/dev/null
docker run --detach \
    --name "${APP_NAME}" \
    --network "${NETWORK_NAME}" \
    --publish 127.0.0.1::3235 \
    --env MQTT_BROKER_URL="mqtt://${BROKER_NAME}:1883" \
    --env MQTT_BASE_TOPIC=zigbee2mqtt \
    --env TRANSPORT_MODE=http \
    --env HTTP_PORT=3235 \
    --env API_KEY="${TEST_TOKEN}" \
    --env ALLOWED_ORIGINS=https://allowed.example \
    --env MAX_SESSIONS=2 \
    --env LOG_LEVEL=debug \
    "${IMAGE_NAME}" >/dev/null

HOST_PORT=$(docker port "${APP_NAME}" 3235/tcp | sed 's/.*://')
BASE_URL="http://127.0.0.1:${HOST_PORT}"

for _attempt in $(seq 1 30); do
    if curl --fail --silent "${BASE_URL}/health" >"${TEST_TMP}/health.json"; then
        break
    fi
    sleep 1
done
jq -e '.status == "ok" and .mqtt_connected == true and length == 2' "${TEST_TMP}/health.json" >/dev/null

STATUS=$(curl --silent --output /dev/null --write-out '%{http_code}' \
    --header 'Content-Type: application/json' \
    --data '{}' "${BASE_URL}/mcp")
test "${STATUS}" = 401

STATUS=$(curl --silent --output /dev/null --write-out '%{http_code}' \
    --header "Authorization: Bearer ${TEST_TOKEN}" \
    --header 'Origin: https://evil.example' \
    --header 'Content-Type: application/json' \
    --data '{}' "${BASE_URL}/mcp")
test "${STATUS}" = 403

INITIALIZE='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"container-smoke","version":"1.0"}}}'
STATUS=$(curl --silent --dump-header "${TEST_TMP}/headers-1" --output "${TEST_TMP}/initialize-1" --write-out '%{http_code}' \
    --header "Authorization: Bearer ${TEST_TOKEN}" \
    --header 'Accept: application/json, text/event-stream' \
    --header 'Content-Type: application/json' \
    --data "${INITIALIZE}" "${BASE_URL}/mcp")
test "${STATUS}" = 200
SESSION_ONE=$(sed -n 's/^[Mm][Cc][Pp]-[Ss]ession-[Ii]d: *\([^\r]*\).*/\1/p' "${TEST_TMP}/headers-1")
test -n "${SESSION_ONE}"
rg -q '"version":"1.2.0"' "${TEST_TMP}/initialize-1"

STATUS=$(curl --silent --output /dev/null --write-out '%{http_code}' \
    --header "Authorization: Bearer ${TEST_TOKEN}" \
    --header "MCP-Session-Id: ${SESSION_ONE}" \
    --header 'Accept: application/json, text/event-stream' \
    --header 'Content-Type: application/json' \
    --data '{"jsonrpc":"2.0","method":"notifications/initialized"}' "${BASE_URL}/mcp")
test "${STATUS}" = 202 -o "${STATUS}" = 200

STATUS=$(curl --silent --dump-header "${TEST_TMP}/headers-2" --output "${TEST_TMP}/initialize-2" --write-out '%{http_code}' \
    --header "Authorization: Bearer ${TEST_TOKEN}" \
    --header 'Accept: application/json, text/event-stream' \
    --header 'Content-Type: application/json' \
    --data "${INITIALIZE}" "${BASE_URL}/mcp")
test "${STATUS}" = 200
SESSION_TWO=$(sed -n 's/^[Mm][Cc][Pp]-[Ss]ession-[Ii]d: *\([^\r]*\).*/\1/p' "${TEST_TMP}/headers-2")
test -n "${SESSION_TWO}"

STATUS=$(curl --silent --output /dev/null --write-out '%{http_code}' \
    --header "Authorization: Bearer ${TEST_TOKEN}" \
    --header 'Accept: application/json, text/event-stream' \
    --header 'Content-Type: application/json' \
    --data "${INITIALIZE}" "${BASE_URL}/mcp")
test "${STATUS}" = 503

node -e 'process.stdout.write(JSON.stringify({payload:"x".repeat(70*1024)}))' >"${TEST_TMP}/oversized.json"
STATUS=$(curl --silent --output /dev/null --write-out '%{http_code}' \
    --header "Authorization: Bearer ${TEST_TOKEN}" \
    --header 'Content-Type: application/json' \
    --data-binary "@${TEST_TMP}/oversized.json" "${BASE_URL}/mcp")
test "${STATUS}" = 413

for SESSION_ID in "${SESSION_ONE}" "${SESSION_TWO}"; do
    curl --silent --output /dev/null \
        --request DELETE \
        --header "Authorization: Bearer ${TEST_TOKEN}" \
        --header "MCP-Session-Id: ${SESSION_ID}" \
        --header 'Accept: application/json, text/event-stream' \
        "${BASE_URL}/mcp"
done

set +e
curl --silent --max-time 2 \
    --header "Authorization: Bearer ${TEST_TOKEN}" \
    "${BASE_URL}/sse" >"${TEST_TMP}/sse"
SSE_EXIT=$?
set -e
test "${SSE_EXIT}" = 28
rg -q 'event: endpoint' "${TEST_TMP}/sse"

docker exec "${BROKER_NAME}" mosquitto_pub \
    --topic zigbee2mqtt/bridge/devices \
    --retain \
    --message '[{"ieee_address":"0x1234","friendly_name":"test/room/lamp","type":"Router","definition":{"model":"TEST","vendor":"Test","description":"Test","exposes":[{"type":"binary","name":"state","property":"state","access":7,"value_on":"ON","value_off":"OFF"}]}}]'
for ITERATION in $(seq 1 20); do
    docker exec "${BROKER_NAME}" mosquitto_pub \
        --topic zigbee2mqtt/test/room/lamp \
        --message "{\"state\":\"$([ $((ITERATION % 2)) = 0 ] && echo ON || echo OFF)\"}"
    curl --fail --silent "${BASE_URL}/health" >/dev/null
    sleep 0.25
done

docker stop --time 10 "${APP_NAME}" >/dev/null
EXIT_CODE=$(docker inspect --format '{{.State.ExitCode}}' "${APP_NAME}")
test "${EXIT_CODE}" = 0
docker logs "${APP_NAME}" >"${TEST_TMP}/app.log" 2>&1
if rg -q 'RemoveEnvironmentCleanupHook|exit code 134|Aborted|Assertion failed' "${TEST_TMP}/app.log"; then
    echo 'Native Node shutdown failure detected' >&2
    exit 1
fi
if rg -q "${TEST_TOKEN}" "${TEST_TMP}/app.log"; then
    echo 'Bearer token leaked to logs' >&2
    exit 1
fi

echo 'Container smoke test passed'
