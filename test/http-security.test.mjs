import assert from 'node:assert/strict';
import test from 'node:test';
import { constantTimeTokenEquals, startHttpServer } from '../dist/http-server.js';

const TOKEN = 'test-token-with-at-least-24-chars';

function config(overrides = {}) {
  return {
    mqtt: { brokerUrl: 'mqtt://localhost:1883', baseTopic: 'zigbee2mqtt' },
    dbPath: ':memory:',
    transportMode: 'http',
    httpHost: '127.0.0.1',
    httpPort: 0,
    apiKey: TOKEN,
    allowedOrigins: ['https://allowed.example'],
    sslEnabled: false,
    sslCertFile: '/unused',
    sslKeyFile: '/unused',
    maxSessions: 4,
    allowDestructive: false,
    logLevel: 'silent',
    homeAssistant: false,
    warnings: [],
    ...overrides,
  };
}

const db = {
  getAllDevices: () => [],
  getStats: () => ({ deviceCount: 0, fieldCount: 0, capabilityCount: 0 }),
};
const mqtt = { isConnected: () => true };

function authHeaders(extra = {}) {
  return {
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...extra,
  };
}

function mcpBody(id, method, params = undefined) {
  return JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
}

async function responseMessage(response) {
  const text = await response.text();
  const dataLine = text.split('\n').find(line => line.startsWith('data: '));
  return JSON.parse(dataLine ? dataLine.slice(6) : text);
}

test('constant-time token helper compares hashed values of any length', () => {
  assert.equal(constantTimeTokenEquals(TOKEN, TOKEN), true);
  assert.equal(constantTimeTokenEquals(TOKEN, 'wrong'), false);
  assert.equal(constantTimeTokenEquals('', 'wrong'), false);
});

test('HTTP transports enforce auth, origins, limits, sessions, and legacy SSE', async () => {
  const service = await startHttpServer(config(), db, mqtt);
  const base = `http://127.0.0.1:${service.port}`;
  try {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok', mqtt_connected: true });

    const unauthorized = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: mcpBody(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }),
    });
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get('www-authenticate'), 'Bearer');

    const forbidden = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: authHeaders({ origin: 'https://evil.example' }),
      body: mcpBody(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }),
    });
    assert.equal(forbidden.status, 403);

    const initialize = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: authHeaders({ origin: 'https://allowed.example' }),
      body: mcpBody(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }),
    });
    assert.equal(initialize.status, 200);
    assert.equal(initialize.headers.get('access-control-allow-origin'), 'https://allowed.example');
    const sessionId = initialize.headers.get('mcp-session-id');
    assert.ok(sessionId);
    const initialized = await responseMessage(initialize);
    assert.equal(initialized.result.serverInfo.version, '1.2.0');

    const notification = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: authHeaders({ 'mcp-session-id': sessionId }),
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    assert.ok([200, 202].includes(notification.status));

    const tools = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: authHeaders({ 'mcp-session-id': sessionId }),
      body: mcpBody(2, 'tools/list'),
    });
    assert.equal(tools.status, 200);
    const toolMessage = await responseMessage(tools);
    const toolNames = toolMessage.result.tools.map(tool => tool.name);
    assert.ok(toolNames.includes('get_bridge_info'));
    assert.ok(!toolNames.includes('remove_device'));

    const oversized = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ payload: 'x'.repeat(70 * 1024) }),
    });
    assert.equal(oversized.status, 413);

    const controller = new AbortController();
    const sse = await fetch(`${base}/sse`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: controller.signal,
    });
    assert.equal(sse.status, 200);
    const firstChunk = await sse.body.getReader().read();
    assert.match(new TextDecoder().decode(firstChunk.value), /event: endpoint/);
    controller.abort();
  } finally {
    await service.close();
  }
});

test('session and authentication failure limits are enforced', async () => {
  const service = await startHttpServer(config({ maxSessions: 1 }), db, mqtt);
  const base = `http://127.0.0.1:${service.port}`;
  const initializeBody = mcpBody(1, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  });
  try {
    const first = await fetch(`${base}/mcp`, { method: 'POST', headers: authHeaders(), body: initializeBody });
    assert.equal(first.status, 200);
    await first.text();
    const second = await fetch(`${base}/mcp`, { method: 'POST', headers: authHeaders(), body: initializeBody });
    assert.equal(second.status, 503);

    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { authorization: 'Bearer definitely-wrong-token', 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(response.status, 401);
    }
    const limited = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer definitely-wrong-token', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(limited.status, 429);
  } finally {
    await service.close();
  }
});

test('destructive tools require both opt-in and explicit confirmation', async () => {
  const service = await startHttpServer(config({ allowDestructive: true }), db, mqtt);
  const base = `http://127.0.0.1:${service.port}`;
  try {
    const initialize = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: authHeaders(),
      body: mcpBody(1, 'initialize', {
        protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' },
      }),
    });
    const sessionId = initialize.headers.get('mcp-session-id');
    assert.equal(initialize.status, 200);
    assert.ok(sessionId);
    await initialize.text();

    const tools = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: authHeaders({ 'mcp-session-id': sessionId }),
      body: mcpBody(2, 'tools/list'),
    });
    const toolMessage = await responseMessage(tools);
    const removeDevice = toolMessage.result.tools.find(tool => tool.name === 'remove_device');
    assert.ok(removeDevice);
    assert.ok(removeDevice.inputSchema.required.includes('confirm'));
    assert.equal(removeDevice.inputSchema.properties.confirm.const, true);
    assert.equal(removeDevice.annotations.destructiveHint, true);

    const rejected = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: authHeaders({ 'mcp-session-id': sessionId }),
      body: mcpBody(3, 'tools/call', { name: 'remove_device', arguments: { id: 'test-device' } }),
    });
    const rejection = await responseMessage(rejected);
    assert.equal(rejection.result.isError, true);
    assert.match(rejection.result.content[0].text, /requires confirm=true/);
  } finally {
    await service.close();
  }
});
