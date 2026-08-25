import { randomUUID } from 'node:crypto';
import mqtt from 'mqtt';
import { ZigbeeDatabase } from './database.js';
import { SchemaDiscovery } from './schema-discovery.js';
import { Z2MDevice } from './types.js';
import { logger } from './logger.js';

export interface MqttConfig {
  brokerUrl: string;
  username?: string;
  password?: string;
  baseTopic: string;
}

interface PendingRequest {
  path: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

interface BridgeResponse {
  status?: string;
  data?: unknown;
  error?: string;
  transaction?: string;
}

function redactUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) {
      parsed.username = 'redacted';
      parsed.password = 'redacted';
    }
    return parsed.toString();
  } catch {
    return '[configured URL]';
  }
}

function sanitize(value: unknown, key = ''): unknown {
  if (/password|network_key|auth_token|secret/i.test(key)) return '[redacted]';
  if (Array.isArray(value)) return value.map(item => sanitize(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, sanitize(child, childKey)]));
  }
  if (typeof value === 'string' && /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return redactUrl(value);
  return value;
}

export class MqttListener {
  private client: mqtt.MqttClient | null = null;
  private readonly discovery: SchemaDiscovery;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 10;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private bridgeInfo: unknown = null;
  private groups: unknown[] = [];
  private bridgeHealth: unknown = null;
  private converters: unknown[] = [];

  constructor(private readonly config: MqttConfig, private readonly db: ZigbeeDatabase) {
    this.discovery = new SchemaDiscovery(db);
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      logger.debug(`Connecting to MQTT broker: ${redactUrl(this.config.brokerUrl)}`);
      this.client = mqtt.connect(this.config.brokerUrl, {
        username: this.config.username,
        password: this.config.password,
        reconnectPeriod: 5000,
        clean: false,
        clientId: `zigbee2mqtt-mcp-${randomUUID()}`,
      });

      this.client.on('connect', () => {
        logger.debug('Connected to MQTT broker');
        this.reconnectAttempts = 0;
        this.subscribeToTopics();
        resolve();
      });
      this.client.on('error', error => {
        logger.error('MQTT Error:', error.message);
        if (this.reconnectAttempts === 0) reject(error);
      });
      this.client.on('reconnect', () => {
        this.reconnectAttempts++;
        logger.warn(`Reconnecting to MQTT (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
        if (this.reconnectAttempts >= this.maxReconnectAttempts) this.client?.end();
      });
      this.client.on('offline', () => {
        logger.warn('MQTT client offline');
        this.rejectPendingRequests(new Error('MQTT client disconnected'));
      });
      this.client.on('message', (topic, payload) => this.handleMessage(topic, payload));
    });
  }

  private subscribeToTopics(): void {
    if (!this.client) return;
    const topic = `${this.config.baseTopic}/#`;
    this.client.subscribe(topic, { qos: 1 }, error => {
      if (error) logger.error(`Failed to subscribe to ${topic}:`, error);
      else logger.debug(`Subscribed to ${topic}`);
    });
  }

  private handleMessage(topic: string, payload: Buffer): void {
    if (payload.length > 1024 * 1024) {
      logger.warn(`Ignoring oversized MQTT message on ${topic}`);
      return;
    }

    try {
      const prefix = `${this.config.baseTopic}/`;
      if (!topic.startsWith(prefix)) return;
      const relativeTopic = topic.slice(prefix.length);
      const message = payload.toString();

      if (relativeTopic.startsWith('bridge/response/')) {
        this.handleBridgeResponse(relativeTopic.slice('bridge/response/'.length), message);
        return;
      }
      if (relativeTopic === 'bridge/devices') {
        this.handleBridgeDevices(message);
        return;
      }
      if (relativeTopic === 'bridge/info') {
        this.bridgeInfo = JSON.parse(message);
        return;
      }
      if (relativeTopic === 'bridge/groups') {
        const groups = JSON.parse(message);
        this.groups = Array.isArray(groups) ? groups : [];
        return;
      }
      if (relativeTopic === 'bridge/health') {
        this.bridgeHealth = JSON.parse(message);
        return;
      }
      if (relativeTopic === 'bridge/converters') {
        const converters = JSON.parse(message);
        this.converters = Array.isArray(converters) ? converters : [];
        return;
      }
      if (relativeTopic === 'bridge/state') {
        logger.debug('Bridge state:', message);
        return;
      }
      if (relativeTopic.endsWith('/availability')) {
        this.handleDeviceAvailability(relativeTopic.slice(0, -'/availability'.length), message);
        return;
      }
      if (relativeTopic.startsWith('bridge/') || relativeTopic.endsWith('/set') || relativeTopic.endsWith('/get')) return;
      this.handleDeviceState(relativeTopic, message);
    } catch (error) {
      logger.error(`Error handling message from ${topic}:`, error);
    }
  }

  private handleBridgeResponse(path: string, message: string): void {
    const response = JSON.parse(message) as BridgeResponse;
    if (!response.transaction) return;
    const pending = this.pendingRequests.get(response.transaction);
    if (!pending || pending.path !== path) return;
    clearTimeout(pending.timer);
    this.pendingRequests.delete(response.transaction);
    if (response.status === 'error') pending.reject(new Error(response.error || `Zigbee2MQTT request ${path} failed`));
    else pending.resolve(response.data ?? response);
  }

  private handleBridgeDevices(message: string): void {
    try {
      const devices: Z2MDevice[] = JSON.parse(message);
      logger.info(`Discovered ${devices.length} devices`);
      devices.filter(device => device.type !== 'Coordinator').forEach(device => {
        try {
          this.discovery.processDevice(device);
        } catch (error) {
          logger.error(`Skipping device ${device.friendly_name} (${device.ieee_address}):`, error);
        }
      });
      this.db.removeDevicesNotIn(
        devices.filter(device => device.type !== 'Coordinator').map(device => device.ieee_address)
      );
      const stats = this.db.getStats();
      logger.debug(`Database: ${stats.deviceCount} devices, ${stats.fieldCount} fields, ${stats.capabilityCount} capabilities`);
    } catch (error) {
      logger.error('Error processing bridge/devices:', error);
    }
  }

  private handleDeviceAvailability(friendlyName: string, message: string): void {
    try {
      const data = JSON.parse(message);
      const device = this.db.getDevice(friendlyName);
      if (!device) return;
      const currentState = this.db.getDeviceState(device.ieee_address) || {};
      currentState.availability = data.state;
      this.db.updateDeviceState(device.ieee_address, currentState);
      this.db.updateDeviceLastSeen(device.ieee_address);
    } catch {
      // Ignore non-JSON availability messages.
    }
  }

  private handleDeviceState(friendlyName: string, message: string): void {
    try {
      const state = JSON.parse(message);
      const device = this.db.getDevice(friendlyName);
      if (!device) {
        logger.debug(`Received state for unknown device: ${friendlyName}`);
        return;
      }
      this.db.updateDeviceState(device.ieee_address, state);
      this.db.updateDeviceLastSeen(device.ieee_address);
      this.discovery.processDeviceState(device.ieee_address, state);
    } catch {
      // Ignore non-JSON messages.
    }
  }

  async requestBridge(path: string, data: Record<string, unknown> = {}, timeoutMs = 30000): Promise<unknown> {
    if (!this.client?.connected) throw new Error('MQTT client not connected');
    if (this.pendingRequests.size >= 64) throw new Error('Too many pending Zigbee2MQTT requests');
    const transaction = randomUUID();
    const payload = JSON.stringify({ ...data, transaction });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(transaction);
        reject(new Error(`Zigbee2MQTT request ${path} timed out`));
      }, timeoutMs);
      this.pendingRequests.set(transaction, { path, resolve, reject, timer });
      this.client!.publish(`${this.config.baseTopic}/bridge/request/${path}`, payload, { qos: 1 }, error => {
        if (!error) return;
        clearTimeout(timer);
        this.pendingRequests.delete(transaction);
        reject(error);
      });
    });
  }

  private rejectPendingRequests(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  getBridgeInfo(): unknown { return sanitize(this.bridgeInfo); }
  getGroups(): unknown[] { return this.groups; }
  getBridgeHealth(): unknown { return this.bridgeHealth; }
  getConverters(): unknown[] { return this.converters; }

  async disconnect(): Promise<void> {
    this.rejectPendingRequests(new Error('MQTT client stopped'));
    return new Promise(resolve => {
      if (!this.client) return resolve();
      this.client.end(false, {}, () => {
        logger.debug('Disconnected from MQTT broker');
        resolve();
      });
    });
  }

  isConnected(): boolean { return this.client?.connected || false; }

  async publishCommand(friendlyName: string, command: Record<string, unknown>): Promise<void> {
    if (!this.client?.connected) throw new Error('MQTT client not connected');
    const topic = `${this.config.baseTopic}/${friendlyName}/set`;
    const payload = JSON.stringify(command);
    return new Promise((resolve, reject) => {
      this.client!.publish(topic, payload, { qos: 1 }, error => {
        if (error) reject(error);
        else {
          logger.debug(`Published command to ${topic}`);
          resolve();
        }
      });
    });
  }
}
