import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { LogLevel } from './logger.js';

export type TransportMode = 'stdio' | 'http';

export interface AppConfig {
  mqtt: {
    brokerUrl: string;
    username?: string;
    password?: string;
    baseTopic: string;
  };
  dbPath: string;
  transportMode: TransportMode;
  httpHost: string;
  httpPort: number;
  apiKey?: string;
  allowedOrigins: string[];
  sslEnabled: boolean;
  sslCertFile: string;
  sslKeyFile: string;
  maxSessions: number;
  allowDestructive: boolean;
  logLevel: LogLevel;
  homeAssistant: boolean;
  warnings: string[];
}

type Environment = NodeJS.ProcessEnv;
type Options = Record<string, unknown>;

const TOKEN_PATTERN = /^[A-Za-z0-9._~+\/-]+={0,}$/;
const MQTT_PROTOCOLS = new Set(['mqtt:', 'mqtts:', 'ws:', 'wss:']);

function readOptions(path: string): Options | undefined {
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot parse Home Assistant options at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Home Assistant options at ${path} must contain a JSON object`);
  }
  return parsed as Options;
}

function hasEnvironmentValue(env: Environment, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(env, key);
}

function select(env: Environment, options: Options | undefined, envKey: string, optionKey: string): unknown {
  return hasEnvironmentValue(env, envKey) ? env[envKey] : options?.[optionKey];
}

function stringValue(value: unknown, fallback: string, name: string, allowEmpty = false): string {
  const result = value === undefined || value === null ? fallback : String(value);
  if (!allowEmpty && result.trim().length === 0) throw new Error(`${name} must not be empty`);
  if (result.includes('\0')) throw new Error(`${name} contains an invalid NUL character`);
  return result;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return stringValue(value, '', name);
}

function booleanValue(value: unknown, fallback: boolean, name: string): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${name} must be true or false`);
}

function integerValue(value: unknown, fallback: number, name: string, minimum: number, maximum: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function validateMqttUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('MQTT_BROKER_URL must be a valid URL');
  }
  if (!MQTT_PROTOCOLS.has(parsed.protocol) || !parsed.hostname) {
    throw new Error('MQTT_BROKER_URL must use mqtt, mqtts, ws, or wss and include a host');
  }
  return value;
}

function validateBaseTopic(value: string): string {
  if (value.includes('+') || value.includes('#') || value.startsWith('/') || value.endsWith('/')) {
    throw new Error('MQTT_BASE_TOPIC must not contain wildcards or leading/trailing slashes');
  }
  return value;
}

function validateCertificateName(value: string, name: string): string {
  if (basename(value) !== value || value === '.' || value === '..') {
    throw new Error(`${name} must be a file name inside /ssl`);
  }
  return value;
}

function parseOrigins(value: unknown): string[] {
  const raw = value === undefined || value === null ? '' : String(value);
  const origins = raw.split(',').map(origin => origin.trim()).filter(Boolean);
  return [...new Set(origins.map(origin => {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`Invalid allowed origin: ${origin}`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error(`Allowed origin must be an http(s) origin without credentials or a path: ${origin}`);
    }
    return parsed.origin;
  }))];
}

function loadLegacyToken(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  chmodSync(path, 0o600);
  const token = readFileSync(path, 'utf8').trim();
  return token || undefined;
}

export function loadConfig(env: Environment = process.env, explicitOptionsPath?: string): AppConfig {
  const optionsPath = explicitOptionsPath ?? env.HA_OPTIONS_PATH ?? '/data/options.json';
  const options = readOptions(optionsPath);
  const homeAssistant = options !== undefined;
  const warnings: string[] = [];

  const brokerUrl = validateMqttUrl(stringValue(
    select(env, options, 'MQTT_BROKER_URL', 'mqtt_broker_url'),
    'mqtt://localhost:1883',
    'MQTT_BROKER_URL',
  ));
  const baseTopic = validateBaseTopic(stringValue(
    select(env, options, 'MQTT_BASE_TOPIC', 'mqtt_base_topic'),
    'zigbee2mqtt',
    'MQTT_BASE_TOPIC',
  ));
  const transportMode = stringValue(
    select(env, options, 'TRANSPORT_MODE', 'transport_mode'),
    'stdio',
    'TRANSPORT_MODE',
  ) as TransportMode;
  if (!['stdio', 'http'].includes(transportMode)) throw new Error('TRANSPORT_MODE must be stdio or http');

  const sslEnabled = booleanValue(select(env, options, 'SSL_ENABLED', 'ssl'), false, 'SSL_ENABLED');
  const certName = validateCertificateName(
    stringValue(options?.certfile, 'fullchain.pem', 'certfile'),
    'certfile',
  );
  const keyName = validateCertificateName(
    stringValue(options?.keyfile, 'privkey.pem', 'keyfile'),
    'keyfile',
  );
  const sslCertFile = hasEnvironmentValue(env, 'SSL_CERTFILE')
    ? stringValue(env.SSL_CERTFILE, '', 'SSL_CERTFILE')
    : join('/ssl', certName);
  const sslKeyFile = hasEnvironmentValue(env, 'SSL_KEYFILE')
    ? stringValue(env.SSL_KEYFILE, '', 'SSL_KEYFILE')
    : join('/ssl', keyName);

  const apiKeyValue = select(env, options, 'API_KEY', 'api_key');
  let apiKey = optionalString(apiKeyValue, 'API_KEY');
  if (transportMode === 'http' && !apiKey && !hasEnvironmentValue(env, 'API_KEY')) {
    const legacyPath = env.LEGACY_API_KEY_PATH ?? '/data/.api_key';
    apiKey = loadLegacyToken(legacyPath);
    if (apiKey) warnings.push('Using the legacy generated access token; configure api_key explicitly when rotating it.');
  }
  if (transportMode === 'http') {
    if (!apiKey) throw new Error('API_KEY is required in HTTP mode');
    if (apiKey.length < 24) throw new Error('API_KEY must contain at least 24 characters');
    if (apiKey.length > 512) throw new Error('API_KEY must not exceed 512 characters');
    if (!TOKEN_PATTERN.test(apiKey)) throw new Error('API_KEY contains characters that are invalid in an Authorization header');
    if (!sslEnabled) warnings.push('TLS is disabled; expose HTTP only on a trusted network or behind an HTTPS reverse proxy.');
  }

  const logLevel = stringValue(
    select(env, options, 'LOG_LEVEL', 'log_level'),
    'info',
    'LOG_LEVEL',
  ).toLowerCase() as LogLevel;
  if (!['debug', 'info', 'warn', 'error', 'silent'].includes(logLevel)) {
    throw new Error('LOG_LEVEL must be debug, info, warn, error, or silent');
  }

  return {
    mqtt: {
      brokerUrl,
      username: optionalString(select(env, options, 'MQTT_USERNAME', 'mqtt_username'), 'MQTT_USERNAME'),
      password: optionalString(select(env, options, 'MQTT_PASSWORD', 'mqtt_password'), 'MQTT_PASSWORD'),
      baseTopic,
    },
    dbPath: stringValue(env.DB_PATH, homeAssistant ? '/data/mcp2zigbee2mqtt.db' : './zigbee2mqtt.db', 'DB_PATH'),
    transportMode,
    httpHost: stringValue(env.HTTP_HOST, '0.0.0.0', 'HTTP_HOST'),
    httpPort: integerValue(env.HTTP_PORT, 3235, 'HTTP_PORT', 1, 65535),
    apiKey,
    allowedOrigins: parseOrigins(select(env, options, 'ALLOWED_ORIGINS', 'allowed_origins')),
    sslEnabled,
    sslCertFile,
    sslKeyFile,
    maxSessions: integerValue(select(env, options, 'MAX_SESSIONS', 'max_sessions'), 32, 'MAX_SESSIONS', 1, 128),
    allowDestructive: booleanValue(select(env, options, 'ALLOW_DESTRUCTIVE', 'allow_destructive'), false, 'ALLOW_DESTRUCTIVE'),
    logLevel,
    homeAssistant,
    warnings,
  };
}
