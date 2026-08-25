import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { ZigbeeDatabase } from '../dist/database.js';
import { validateDeviceCommand } from '../dist/device-command.js';
import { MqttListener, redactUrl, sanitize } from '../dist/mqtt-listener.js';

test('database migration deduplicates legacy friendly names and restores uniqueness', () => {
  const directory = mkdtempSync(join(tmpdir(), 'z2m-mcp-db-'));
  const path = join(directory, 'legacy.db');
  try {
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE devices (
        ieee_address TEXT PRIMARY KEY,
        friendly_name TEXT NOT NULL,
        model TEXT, vendor TEXT, description TEXT, device_type TEXT,
        last_seen INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      INSERT INTO devices VALUES ('old', 'same/name', NULL, NULL, NULL, NULL, NULL, 1, 1);
      INSERT INTO devices VALUES ('new', 'same/name', NULL, NULL, NULL, NULL, NULL, 2, 2);
    `);
    legacy.close();

    const migrated = new ZigbeeDatabase(path);
    assert.equal(migrated.getAllDevices().length, 1);
    assert.equal(migrated.getAllDevices()[0].ieee_address, 'new');
    migrated.close();
    const verified = new Database(path);
    assert.throws(() => verified.prepare(`
      INSERT INTO devices (ieee_address, friendly_name, created_at, updated_at)
      VALUES ('third', 'same/name', 3, 3)
    `).run(), /UNIQUE/);
    verified.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('friendly names containing slashes receive state and stale devices are removed', () => {
  const database = new ZigbeeDatabase(':memory:');
  const listener = new MqttListener({ brokerUrl: 'mqtt://unused', baseTopic: 'zigbee2mqtt' }, database);
  const device = {
    ieee_address: '0x1234',
    friendly_name: 'floor/room/lamp',
    type: 'Router',
    definition: {
      model: 'TEST', vendor: 'Test', description: 'Test light',
      exposes: [{ type: 'binary', name: 'state', property: 'state', access: 7, value_on: 'ON', value_off: 'OFF' }],
    },
  };

  listener.handleMessage('zigbee2mqtt/bridge/devices', Buffer.from(JSON.stringify([device])));
  listener.handleMessage('zigbee2mqtt/floor/room/lamp', Buffer.from('{"state":"ON"}'));
  assert.deepEqual(database.getDeviceState('0x1234'), { state: 'ON' });
  assert.equal(database.getDeviceFields('0x1234')[0].access, 'read,write,publish');

  listener.handleMessage('zigbee2mqtt/bridge/devices', Buffer.from('[]'));
  assert.equal(database.getAllDevices().length, 0);
  database.close();
});

test('device commands are restricted to writable exposes and their value constraints', () => {
  const fields = [
    { ieee_address: 'x', field_name: 'state', field_type: 'enum', enum_values: ['ON', 'OFF'], access: 'read,write' },
    { ieee_address: 'x', field_name: 'temperature', field_type: 'number', value_min: 0, value_max: 40, access: 'read' },
  ];
  assert.doesNotThrow(() => validateDeviceCommand(fields, { state: 'ON' }));
  assert.throws(() => validateDeviceCommand(fields, { state: 'INVALID' }), /must be one of/);
  assert.throws(() => validateDeviceCommand(fields, { temperature: 20 }), /not writable/);
  assert.throws(() => validateDeviceCommand(fields, { unknown: true }), /Unknown command property/);
});

test('bridge requests use matching transactions and cap pending work', async () => {
  const database = new ZigbeeDatabase(':memory:');
  const listener = new MqttListener({ brokerUrl: 'mqtt://unused', baseTopic: 'zigbee2mqtt' }, database);
  let published;
  listener.client = {
    connected: true,
    publish(topic, payload, _options, callback) {
      published = { topic, payload };
      callback();
    },
    end(_force, _options, callback) { callback(); },
  };
  const pending = listener.requestBridge('health_check');
  const transaction = JSON.parse(published.payload).transaction;
  assert.equal(published.topic, 'zigbee2mqtt/bridge/request/health_check');
  listener.handleMessage(
    'zigbee2mqtt/bridge/response/health_check',
    Buffer.from(JSON.stringify({ status: 'ok', transaction, data: { healthy: true } })),
  );
  assert.deepEqual(await pending, { healthy: true });
  await listener.disconnect();
  database.close();
});

test('MQTT and bridge secrets are redacted', () => {
  assert.equal(redactUrl('mqtt://user:password@broker:1883'), 'mqtt://redacted:redacted@broker:1883');
  assert.deepEqual(sanitize({ network_key: [1, 2], username: 'mqtt-user', nested: { password: 'secret' }, url: 'mqtt://u:p@host' }), {
    network_key: '[redacted]',
    username: '[redacted]',
    nested: { password: '[redacted]' },
    url: 'mqtt://redacted:redacted@host',
  });
});
