import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadConfig } from '../dist/config.js';

const TOKEN = 'test-token-with-at-least-24-chars';

test('Home Assistant options load and explicit environment values win', () => {
  const directory = mkdtempSync(join(tmpdir(), 'z2m-mcp-config-'));
  try {
    const optionsPath = join(directory, 'options.json');
    writeFileSync(optionsPath, JSON.stringify({
      mqtt_broker_url: 'mqtt://ha-broker:1883',
      mqtt_username: 'ha-user',
      mqtt_password: 'ha-password',
      mqtt_base_topic: 'ha-topic',
      transport_mode: 'http',
      api_key: TOKEN,
      allowed_origins: 'https://home.example, https://second.example',
      ssl: false,
      certfile: 'fullchain.pem',
      keyfile: 'privkey.pem',
      max_sessions: 7,
      allow_destructive: false,
      log_level: 'warn',
    }));

    const config = loadConfig({
      MQTT_BROKER_URL: 'mqtts://env-user:env-secret@env-broker:8883',
      MQTT_BASE_TOPIC: 'env-topic',
      API_KEY: 'environment-token-with-24-chars',
      ALLOW_DESTRUCTIVE: 'true',
      MAX_SESSIONS: '9',
    }, optionsPath);

    assert.equal(config.homeAssistant, true);
    assert.equal(config.mqtt.brokerUrl, 'mqtts://env-user:env-secret@env-broker:8883');
    assert.equal(config.mqtt.baseTopic, 'env-topic');
    assert.equal(config.mqtt.password, 'ha-password');
    assert.equal(config.allowDestructive, true);
    assert.equal(config.maxSessions, 9);
    assert.equal(config.dbPath, '/data/mcp2zigbee2mqtt.db');
    assert.deepEqual(config.allowedOrigins, ['https://home.example', 'https://second.example']);
    assert.ok(config.warnings.every(message => !message.includes(config.apiKey)));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('legacy API key remains upgrade-compatible without exposing it', () => {
  const directory = mkdtempSync(join(tmpdir(), 'z2m-mcp-legacy-'));
  try {
    const optionsPath = join(directory, 'options.json');
    const legacyPath = join(directory, '.api_key');
    writeFileSync(optionsPath, JSON.stringify({ transport_mode: 'http', api_key: '', ssl: false }));
    writeFileSync(legacyPath, TOKEN);
    const config = loadConfig({ LEGACY_API_KEY_PATH: legacyPath }, optionsPath);
    assert.equal(config.apiKey, TOKEN);
    assert.ok(config.warnings.some(message => message.includes('legacy')));
    assert.ok(config.warnings.every(message => !message.includes(TOKEN)));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('invalid security and transport settings fail closed', () => {
  assert.throws(
    () => loadConfig({ TRANSPORT_MODE: 'http', API_KEY: 'short' }, '/nonexistent/options.json'),
    /at least 24/,
  );
  assert.throws(
    () => loadConfig({ MQTT_BROKER_URL: 'https://broker.example' }, '/nonexistent/options.json'),
    /mqtt, mqtts, ws, or wss/,
  );
  assert.throws(
    () => loadConfig({ ALLOWED_ORIGINS: 'https://example.test/path' }, '/nonexistent/options.json'),
    /without credentials or a path/,
  );
  assert.throws(
    () => loadConfig({ MAX_SESSIONS: '129' }, '/nonexistent/options.json'),
    /between 1 and 128/,
  );
});
