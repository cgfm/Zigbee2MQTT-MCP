import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { ZigbeeDatabase } from './database.js';
import { validateDeviceCommand } from './device-command.js';
import { MqttListener } from './mqtt-listener.js';
import { DeviceInfo, DeviceFieldInfo, IntegrationInfo } from './types.js';
import { SERVER_VERSION } from './version.js';

const objectSchema = (properties: Record<string, object>, required: string[] = []) => ({
  type: 'object' as const,
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});
const stringArg = (description: string) => ({ type: 'string' as const, minLength: 1, description });

export interface ZigbeeMcpServerOptions {
  allowDestructive?: boolean;
}

const MANAGEMENT_TOOLS: Tool[] = [
  { name: 'get_bridge_info', description: 'Get retained Zigbee2MQTT bridge and coordinator information', inputSchema: objectSchema({}) },
  { name: 'list_groups', description: 'List Zigbee2MQTT groups and their members', inputSchema: objectSchema({}) },
  { name: 'list_converters', description: 'List loaded external converters (read-only)', inputSchema: objectSchema({}) },
  { name: 'create_group', description: 'Create a Zigbee2MQTT group', inputSchema: objectSchema({ name: stringArg('Group friendly name'), id: { type: 'number', minimum: 1, maximum: 65529 } }, ['name']) },
  { name: 'delete_group', description: 'Delete a Zigbee2MQTT group', inputSchema: objectSchema({ group: stringArg('Group ID or friendly name'), force: { type: 'boolean' }, confirm: { type: 'boolean', const: true } }, ['group', 'confirm']) },
  { name: 'rename_group', description: 'Rename a Zigbee2MQTT group', inputSchema: objectSchema({ from: stringArg('Current group ID or name'), to: stringArg('New friendly name'), homeassistant_rename: { type: 'boolean' } }, ['from', 'to']) },
  { name: 'add_device_to_group', description: 'Add a device to a Zigbee2MQTT group', inputSchema: objectSchema({ group: stringArg('Group ID or name'), device: stringArg('Device ID, name, or endpoint') }, ['group', 'device']) },
  { name: 'remove_device_from_group', description: 'Remove a device from a Zigbee2MQTT group', inputSchema: objectSchema({ group: stringArg('Group ID or name'), device: stringArg('Device ID, name, or endpoint') }, ['group', 'device']) },
  { name: 'bind_device', description: 'Bind a source device or endpoint to a target', inputSchema: objectSchema({ from: stringArg('Source device or endpoint'), to: stringArg('Target device, endpoint, or group'), clusters: { type: 'array', items: { type: 'string' }, maxItems: 32 } }, ['from', 'to']) },
  { name: 'unbind_device', description: 'Remove a binding between a source and target', inputSchema: objectSchema({ from: stringArg('Source device or endpoint'), to: stringArg('Target device, endpoint, or group'), clusters: { type: 'array', items: { type: 'string' }, maxItems: 32 } }, ['from', 'to']) },
  { name: 'clear_binds', description: 'Clear all bindings targeting a device or group', inputSchema: objectSchema({ target: stringArg('Target device or group'), confirm: { type: 'boolean', const: true } }, ['target', 'confirm']) },
  { name: 'rename_device', description: 'Rename a Zigbee2MQTT device', inputSchema: objectSchema({ from: stringArg('Current device ID or name'), to: stringArg('New friendly name'), homeassistant_rename: { type: 'boolean' } }, ['from', 'to']) },
  { name: 'remove_device', description: 'Remove a device from the Zigbee network', inputSchema: objectSchema({ id: stringArg('Device ID or friendly name'), block: { type: 'boolean' }, force: { type: 'boolean' }, confirm: { type: 'boolean', const: true } }, ['id', 'confirm']) },
  { name: 'set_device_options', description: 'Change Zigbee2MQTT options for one device', inputSchema: objectSchema({ id: stringArg('Device ID or friendly name'), options: { type: 'object', maxProperties: 32 } }, ['id', 'options']) },
  { name: 'configure_device', description: 'Re-run Zigbee2MQTT device configuration', inputSchema: objectSchema({ id: stringArg('Device ID or friendly name') }, ['id']) },
  { name: 'check_ota_updates', description: 'Check whether a device has a firmware update', inputSchema: objectSchema({ id: stringArg('Device ID or friendly name') }, ['id']) },
  { name: 'schedule_ota_update', description: 'Schedule a device firmware update in Zigbee2MQTT', inputSchema: objectSchema({ id: stringArg('Device ID or friendly name') }, ['id']) },
  { name: 'get_network_map', description: 'Generate a Zigbee network map', inputSchema: objectSchema({ type: { type: 'string', enum: ['raw', 'graphviz', 'plantuml'], default: 'raw' }, routes: { type: 'boolean', default: false } }) },
  { name: 'check_bridge_health', description: 'Run the Zigbee2MQTT bridge health check', inputSchema: objectSchema({}) },
  { name: 'check_coordinator', description: 'Check coordinator connectivity', inputSchema: objectSchema({}) },
  { name: 'restart_zigbee2mqtt', description: 'Restart the Zigbee2MQTT application', inputSchema: objectSchema({ confirm: { type: 'boolean', const: true } }, ['confirm']) },
  { name: 'permit_join', description: 'Enable or disable joining new Zigbee devices', inputSchema: objectSchema({ enabled: { type: 'boolean' }, timeout: { type: 'number', minimum: 1, maximum: 254, default: 254 }, device: { type: 'string' } }, ['enabled']) },
];

const READ_ONLY_TOOLS = new Set([
  'list_devices', 'get_device_info', 'find_devices', 'get_device_state', 'find_by_capability',
  'get_integration_info', 'get_stats', 'get_device_documentation', 'get_recent_devices',
  'get_bridge_info', 'list_groups', 'list_converters', 'get_network_map',
  'check_bridge_health', 'check_coordinator', 'check_ota_updates',
]);
const DESTRUCTIVE_TOOLS = new Set(['delete_group', 'clear_binds', 'remove_device', 'restart_zigbee2mqtt']);
const MANAGEMENT_WRITE_TOOLS = new Set([
  'create_group', 'delete_group', 'rename_group', 'add_device_to_group', 'remove_device_from_group',
  'bind_device', 'unbind_device', 'clear_binds', 'rename_device', 'remove_device',
  'set_device_options', 'configure_device', 'schedule_ota_update', 'restart_zigbee2mqtt', 'permit_join',
]);

async function fetchTextLimited(url: string, limit = 1024 * 1024): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10000), redirect: 'error' });
  if (!response.ok) throw new Error(`Documentation request failed with HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get('content-length') || '0');
  if (declaredLength > limit) throw new Error('Documentation response is too large');
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel();
      throw new Error('Documentation response is too large');
    }
    chunks.push(value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

export class ZigbeeMcpServer {
  private server: Server;
  private db: ZigbeeDatabase;
  private mqtt: MqttListener;
  private baseTopic: string;
  private readonly allowDestructive: boolean;

  constructor(
    db: ZigbeeDatabase,
    mqtt: MqttListener,
    baseTopic: string,
    options: ZigbeeMcpServerOptions = {},
  ) {
    this.db = db;
    this.mqtt = mqtt;
    this.baseTopic = baseTopic;
    this.allowDestructive = options.allowDestructive ?? false;

    this.server = new Server(
      {
        name: 'zigbee2mqtt-mcp',
        version: SERVER_VERSION,
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  getServer(): Server {
    return this.server;
  }

  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.getTools(),
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'list_devices':
            return await this.handleListDevices(args);
          case 'get_device_info':
            return await this.handleGetDeviceInfo(args);
          case 'find_devices':
            return await this.handleFindDevices(args);
          case 'get_device_state':
            return await this.handleGetDeviceState(args);
          case 'send_command':
            return await this.handleSendCommand(args);
          case 'find_by_capability':
            return await this.handleFindByCapability(args);
          case 'get_integration_info':
            return await this.handleGetIntegrationInfo(args);
          case 'get_stats':
            return await this.handleGetStats();
          case 'get_device_documentation':
            return await this.handleGetDeviceDocumentation(args);
          case 'get_recent_devices':
            return await this.handleGetRecentDevices(args);
          default:
            if (MANAGEMENT_TOOLS.some(tool => tool.name === name)) {
              return await this.handleManagementTool(name, args || {});
            }
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    });
  }

  private getTools(): Tool[] {
    const tools: Tool[] = [
      {
        name: 'list_devices',
        description: 'List all ZigBee devices with basic information',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'get_device_info',
        description: 'Get detailed information about a specific device, including all fields, capabilities, and current state',
        inputSchema: {
          type: 'object',
          properties: {
            device: {
              type: 'string',
              description: 'Device friendly name or IEEE address',
            },
          },
          required: ['device'],
        },
      },
      {
        name: 'find_devices',
        description: 'Search for devices by name, model, or description',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query (searches in name, model, description)',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_device_state',
        description: 'Get the current state of a device',
        inputSchema: {
          type: 'object',
          properties: {
            device: {
              type: 'string',
              description: 'Device friendly name or IEEE address',
            },
          },
          required: ['device'],
        },
      },
      {
        name: 'send_command',
        description: 'Send a command to control a device (e.g., turn on/off, set brightness)',
        inputSchema: {
          type: 'object',
          properties: {
            device: {
              type: 'string',
              description: 'Device friendly name or IEEE address',
            },
            command: {
              type: 'object',
              description: 'Command payload (e.g., {"state": "ON"}, {"brightness": 200})',
            },
          },
          required: ['device', 'command'],
        },
      },
      {
        name: 'find_by_capability',
        description: 'Find all devices with a specific capability (e.g., lights, temperature sensors)',
        inputSchema: {
          type: 'object',
          properties: {
            capability: {
              type: 'string',
              description: 'Capability type (e.g., on_off, brightness, temperature_sensor)',
            },
          },
          required: ['capability'],
        },
      },
      {
        name: 'get_integration_info',
        description: 'Get information for integrating a device with other systems like n8n (MQTT topics, commands, examples)',
        inputSchema: {
          type: 'object',
          properties: {
            device: {
              type: 'string',
              description: 'Device friendly name or IEEE address',
            },
          },
          required: ['device'],
        },
      },
      {
        name: 'get_stats',
        description: 'Get statistics about the ZigBee network (number of devices, fields, capabilities)',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'get_device_documentation',
        description: 'Get link to official Zigbee2MQTT documentation for a specific device model. Useful for detailed device specifications, supported features, and troubleshooting.',
        inputSchema: {
          type: 'object',
          properties: {
            device: {
              type: 'string',
              description: 'Device friendly name or IEEE address',
            },
          },
          required: ['device'],
        },
      },
      {
        name: 'get_recent_devices',
        description: 'List devices that were added to the ZigBee network within the last N days. Useful for finding newly paired devices.',
        inputSchema: {
          type: 'object',
          properties: {
            days: {
              type: 'number',
              description: 'Number of days to look back (default: 7)',
            },
          },
        },
      },
    ];
    return [...tools, ...MANAGEMENT_TOOLS]
      .filter(tool => this.allowDestructive || !MANAGEMENT_WRITE_TOOLS.has(tool.name))
      .map(tool => ({
      ...tool,
      annotations: {
        readOnlyHint: READ_ONLY_TOOLS.has(tool.name),
        destructiveHint: DESTRUCTIVE_TOOLS.has(tool.name),
        idempotentHint: READ_ONLY_TOOLS.has(tool.name),
        openWorldHint: tool.name === 'get_device_documentation',
      },
      }));
  }

  private async handleListDevices(_args: any) {
    const devices = this.db.getAllDevices();

    const deviceList = devices.map(d => ({
      friendly_name: d.friendly_name,
      ieee_address: d.ieee_address,
      model: d.model || 'Unknown',
      vendor: d.vendor || 'Unknown',
      type: d.device_type || 'Unknown',
      created_at: d.created_at,
      last_seen: d.last_seen,
      updated_at: d.updated_at,
    }));

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(deviceList, null, 2),
        },
      ],
    };
  }

  private async handleGetDeviceInfo(args: any) {
    const { device } = args;
    const dbDevice = this.db.getDevice(device);

    if (!dbDevice) {
      throw new Error(`Device not found: ${device}`);
    }

    const fields = this.db.getDeviceFields(dbDevice.ieee_address);
    const capabilities = this.db.getDeviceCapabilities(dbDevice.ieee_address);
    const currentState = this.db.getDeviceState(dbDevice.ieee_address);

    const deviceInfo: DeviceInfo = {
      ieee_address: dbDevice.ieee_address,
      friendly_name: dbDevice.friendly_name,
      model: dbDevice.model,
      vendor: dbDevice.vendor,
      description: dbDevice.description,
      device_type: dbDevice.device_type,
      fields: fields.map(f => ({
        name: f.field_name,
        type: f.field_type,
        min: f.value_min,
        max: f.value_max,
        values: f.enum_values,
        unit: f.unit,
        description: f.description,
        access: f.access,
      })),
      capabilities: capabilities.map(c => c.capability_type),
      current_state: currentState || undefined,
      created_at: dbDevice.created_at,
      last_seen: dbDevice.last_seen,
      updated_at: dbDevice.updated_at,
    };

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(deviceInfo, null, 2),
        },
      ],
    };
  }

  private async handleFindDevices(args: any) {
    const { query } = args;
    const devices = this.db.searchDevices(query);

    const deviceList = devices.map(d => ({
      friendly_name: d.friendly_name,
      ieee_address: d.ieee_address,
      model: d.model || 'Unknown',
      vendor: d.vendor || 'Unknown',
      description: d.description,
    }));

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(deviceList, null, 2),
        },
      ],
    };
  }

  private async handleGetDeviceState(args: any) {
    const { device } = args;
    const dbDevice = this.db.getDevice(device);

    if (!dbDevice) {
      throw new Error(`Device not found: ${device}`);
    }

    const state = this.db.getDeviceState(dbDevice.ieee_address);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(state || {}, null, 2),
        },
      ],
    };
  }

  private async handleSendCommand(args: any) {
    const { device, command } = args;
    const dbDevice = this.db.getDevice(device);

    if (!dbDevice) {
      throw new Error(`Device not found: ${device}`);
    }

    validateDeviceCommand(this.db.getDeviceFields(dbDevice.ieee_address), command);
    await this.mqtt.publishCommand(dbDevice.friendly_name, command);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Command sent to ${dbDevice.friendly_name}: ${JSON.stringify(command)}`,
        },
      ],
    };
  }

  private async handleFindByCapability(args: any) {
    const { capability } = args;
    const devices = this.db.findDevicesByCapability(capability);

    const deviceList = devices.map(d => ({
      friendly_name: d.friendly_name,
      ieee_address: d.ieee_address,
      model: d.model || 'Unknown',
      vendor: d.vendor || 'Unknown',
    }));

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(deviceList, null, 2),
        },
      ],
    };
  }

  private async handleGetIntegrationInfo(args: any) {
    const { device } = args;
    const dbDevice = this.db.getDevice(device);

    if (!dbDevice) {
      throw new Error(`Device not found: ${device}`);
    }

    const fields = this.db.getDeviceFields(dbDevice.ieee_address);
    const capabilities = this.db.getDeviceCapabilities(dbDevice.ieee_address);

    // Build example commands based on capabilities
    const exampleCommands: Record<string, any> = {};

    capabilities.forEach(cap => {
      if (cap.capability_type === 'on_off') {
        exampleCommands.turn_on = { state: 'ON' };
        exampleCommands.turn_off = { state: 'OFF' };
        exampleCommands.toggle = { state: 'TOGGLE' };
      }
      if (cap.capability_type === 'brightness') {
        exampleCommands.set_brightness = { brightness: 128 };
      }
      if (cap.capability_type === 'color_temperature') {
        exampleCommands.set_color_temp = { color_temp: 300 };
      }
    });

    const integrationInfo: IntegrationInfo = {
      device: dbDevice.friendly_name,
      mqtt_topic_get: `${this.baseTopic}/${dbDevice.friendly_name}`,
      mqtt_topic_set: `${this.baseTopic}/${dbDevice.friendly_name}/set`,
      available_commands: exampleCommands,
      example_payloads: {
        read_state: `Subscribe to: ${this.baseTopic}/${dbDevice.friendly_name}`,
        set_commands: exampleCommands,
      },
    };

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(integrationInfo, null, 2),
        },
      ],
    };
  }

  private async handleGetStats() {
    const stats = this.db.getStats();

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(stats, null, 2),
        },
      ],
    };
  }

  private async handleGetDeviceDocumentation(args: any) {
    const { device } = args;
    const dbDevice = this.db.getDevice(device);

    if (!dbDevice) {
      throw new Error(`Device not found: ${device}`);
    }

    const model = dbDevice.model || 'Unknown';
    const vendor = dbDevice.vendor || 'Unknown';
    const capabilities = this.db.getDeviceCapabilities(dbDevice.ieee_address);
    const fields = this.db.getDeviceFields(dbDevice.ieee_address);

    // Construct Zigbee2MQTT documentation URLs
    const devicePageUrl = `https://www.zigbee2mqtt.io/devices/${model}.html`;
    const searchUrl = `https://www.zigbee2mqtt.io/supported-devices/#s=${encodeURIComponent(model)}`;

    // Try to fetch the actual device documentation page
    let fetchedInfo: any = null;
    try {
      const html = await fetchTextLimited(devicePageUrl);
      fetchedInfo = this.parseDeviceDocumentation(html);
    } catch (error) {
      // If fetch fails, continue with basic info
    }

    // Build documentation response
    const documentation = {
      device: dbDevice.friendly_name,
      model: model,
      vendor: vendor,
      documentation_url: devicePageUrl,
      search_url: searchUrl,
      device_info: {
        ieee_address: dbDevice.ieee_address,
        description: dbDevice.description || 'No description available',
        capabilities: capabilities.map(c => c.capability_type),
        fields: fields.map(f => ({
          name: f.field_name,
          type: f.field_type,
          unit: f.unit,
          values: f.enum_values
        })),
      },
      ...(fetchedInfo && {
        zigbee2mqtt_documentation: fetchedInfo,
      }),
      hint: `Full documentation available at: ${devicePageUrl}`,
    };

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(documentation, null, 2),
        },
      ],
    };
  }

  private parseDeviceDocumentation(html: string): any {
    const info: any = {};

    // Helper function to extract text between headings
    const extractSection = (heading: string, maxLength?: number): string | null => {
      const regex = new RegExp(`<h2[^>]*>${heading}<\\/h2>([\\s\\S]*?)(?:<h2|<div class="footer"|$)`, 'i');
      const match = html.match(regex);
      if (match) {
        let text = match[1]
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&quot;/g, '"')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/\s+/g, ' ')
          .trim();

        if (maxLength && text.length > maxLength) {
          text = text.substring(0, maxLength) + '...';
        }

        return text || null;
      }
      return null;
    };

    // Extract vendor and model from page title or meta
    const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
    if (titleMatch) {
      info.page_title = titleMatch[1].replace(/\s+/g, ' ').trim();
    }

    // Description
    const description = extractSection('Description', 2000);
    if (description) {
      info.description = description;
    }

    // Picture/Image URL
    const imageMatch = html.match(/<img[^>]*src=["']([^"']*(?:jpg|jpeg|png|gif|webp))[^"']*["']/i);
    if (imageMatch) {
      info.image_url = imageMatch[1].startsWith('http')
        ? imageMatch[1]
        : `https://www.zigbee2mqtt.io${imageMatch[1]}`;
    }

    // OTA Support
    if (html.includes('Supports OTA updates') ||
        html.includes('>OTA<') ||
        html.includes('OTA updates supported')) {
      info.ota_supported = true;
    } else if (html.match(/<h2[^>]*>Exposes<\/h2>/i)) {
      info.ota_supported = false;
    }

    // Pairing instructions
    const pairing = extractSection('Pairing', 2000);
    if (pairing) {
      info.pairing_instructions = pairing;
    }

    // Notes
    const notes = extractSection('Notes', 3000);
    if (notes) {
      info.notes = notes;
    }

    // How to use
    const howToUse = extractSection('How to use', 2000);
    if (howToUse) {
      info.how_to_use = howToUse;
    }

    // Manual Home Assistant configuration
    const haConfig = extractSection('Manual Home Assistant configuration', 2000);
    if (haConfig) {
      info.home_assistant_config = haConfig;
    }

    // Exposes (features) - Extract detailed information
    const exposesMatch = html.match(/<h2[^>]*>Exposes<\/h2>([\s\S]*?)(?:<h2|<div class="footer"|$)/i);
    if (exposesMatch) {
      const exposesHtml = exposesMatch[1];
      const exposes: any[] = [];

      // Extract feature sections with h3 headings
      const featureMatches = exposesHtml.matchAll(/<h3[^>]*>(.*?)<\/h3>([\s\S]*?)(?=<h3|$)/gi);
      for (const match of featureMatches) {
        const featureName = match[1].replace(/<[^>]+>/g, '').trim();
        const featureContent = match[2];

        const feature: any = {
          name: featureName
        };

        // Extract feature description
        const descMatch = featureContent.match(/<p[^>]*>(.*?)<\/p>/i);
        if (descMatch) {
          feature.description = descMatch[1]
            .replace(/<[^>]+>/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        }

        // Extract properties from lists or tables
        const properties: string[] = [];
        const propMatches = featureContent.matchAll(/<li[^>]*>(.*?)<\/li>/gi);
        for (const propMatch of propMatches) {
          const prop = propMatch[1]
            .replace(/<[^>]+>/g, '')
            .replace(/\s+/g, ' ')
            .trim();
          if (prop) {
            properties.push(prop);
          }
        }

        if (properties.length > 0) {
          feature.properties = properties;
        }

        // Extract code snippets (MQTT payloads, etc.)
        const codeMatches = featureContent.matchAll(/<code[^>]*>(.*?)<\/code>/gi);
        const codeSnippets: string[] = [];
        for (const codeMatch of codeMatches) {
          const code = codeMatch[1]
            .replace(/&quot;/g, '"')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .trim();
          if (code && !codeSnippets.includes(code)) {
            codeSnippets.push(code);
          }
        }

        if (codeSnippets.length > 0) {
          feature.examples = codeSnippets;
        }

        exposes.push(feature);
      }

      if (exposes.length > 0) {
        info.exposes = exposes;
      }
    }

    // Extract any tables (specifications, etc.)
    const tableMatches = html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi);
    const tables: any[] = [];
    for (const tableMatch of tableMatches) {
      const tableHtml = tableMatch[0];
      const rows: any[] = [];

      const rowMatches = tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
      for (const rowMatch of rowMatches) {
        const cells: string[] = [];
        const cellMatches = rowMatch[1].matchAll(/<t[hd][^>]*>(.*?)<\/t[hd]>/gi);
        for (const cellMatch of cellMatches) {
          cells.push(cellMatch[1]
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/g, ' ')
            .replace(/\s+/g, ' ')
            .trim());
        }
        if (cells.length > 0) {
          rows.push(cells);
        }
      }

      if (rows.length > 0) {
        tables.push(rows);
      }
    }

    if (tables.length > 0) {
      info.specifications = tables;
    }

    // Extract vendor info if present
    const vendorMatch = html.match(/Vendor[:\s]+([^<\n]+)/i);
    if (vendorMatch) {
      info.vendor_from_page = vendorMatch[1].trim();
    }

    // Extract model info if present
    const modelMatch = html.match(/Model[:\s]+([^<\n]+)/i);
    if (modelMatch) {
      info.model_from_page = modelMatch[1].trim();
    }

    // Extract support status
    if (html.includes('Not supported') || html.includes('not supported')) {
      info.support_status = 'not_supported';
    } else if (html.includes('supported')) {
      info.support_status = 'supported';
    }

    // Extract link to external resources (GitHub, vendor site, etc.)
    const links: string[] = [];
    const linkMatches = html.matchAll(/<a[^>]*href=["']([^"']+)["'][^>]*>/gi);
    for (const linkMatch of linkMatches) {
      const url = linkMatch[1];
      if (url.includes('github.com') ||
          url.includes('koenkk') ||
          (url.startsWith('http') && !url.includes('zigbee2mqtt.io'))) {
        if (!links.includes(url)) {
          links.push(url);
        }
      }
    }

    if (links.length > 0) {
      info.external_links = links.slice(0, 10); // Limit to 10 links
    }

    return Object.keys(info).length > 0 ? info : null;
  }

  private async handleGetRecentDevices(args: any) {
    const days = args.days || 7; // Default to 7 days
    const devices = this.db.getRecentDevices(days);

    const deviceList = devices.map(d => ({
      friendly_name: d.friendly_name,
      ieee_address: d.ieee_address,
      model: d.model || 'Unknown',
      vendor: d.vendor || 'Unknown',
      type: d.device_type || 'Unknown',
      created_at: d.created_at,
      last_seen: d.last_seen,
      updated_at: d.updated_at,
    }));

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            days_ago: days,
            device_count: deviceList.length,
            devices: deviceList,
          }, null, 2),
        },
      ],
    };
  }

  private async handleManagementTool(name: string, args: Record<string, any>) {
    if (MANAGEMENT_WRITE_TOOLS.has(name) && !this.allowDestructive) {
      throw new Error(`${name} is disabled; enable allow_destructive explicitly`);
    }
    if (DESTRUCTIVE_TOOLS.has(name) && args.confirm !== true) {
      throw new Error(`${name} requires confirm=true`);
    }
    let result: unknown;
    switch (name) {
      case 'get_bridge_info':
        result = this.mqtt.getBridgeInfo();
        break;
      case 'list_groups':
        result = this.mqtt.getGroups();
        break;
      case 'list_converters':
        result = this.mqtt.getConverters();
        break;
      case 'create_group':
        result = await this.mqtt.requestBridge('group/add', { friendly_name: args.name, id: args.id });
        break;
      case 'delete_group':
        result = await this.mqtt.requestBridge('group/remove', { id: args.group, force: args.force });
        break;
      case 'rename_group':
        result = await this.mqtt.requestBridge('group/rename', {
          from: args.from, to: args.to, homeassistant_rename: args.homeassistant_rename,
        });
        break;
      case 'add_device_to_group':
        result = await this.mqtt.requestBridge('group/members/add', { group: args.group, device: args.device });
        break;
      case 'remove_device_from_group':
        result = await this.mqtt.requestBridge('group/members/remove', { group: args.group, device: args.device });
        break;
      case 'bind_device':
        result = await this.mqtt.requestBridge('device/bind', { from: args.from, to: args.to, clusters: args.clusters });
        break;
      case 'unbind_device':
        result = await this.mqtt.requestBridge('device/unbind', { from: args.from, to: args.to, clusters: args.clusters });
        break;
      case 'clear_binds':
        result = await this.mqtt.requestBridge('device/binds/clear', { target: args.target });
        break;
      case 'rename_device':
        result = await this.mqtt.requestBridge('device/rename', {
          from: args.from, to: args.to, homeassistant_rename: args.homeassistant_rename,
        });
        break;
      case 'remove_device':
        result = await this.mqtt.requestBridge('device/remove', { id: args.id, block: args.block, force: args.force });
        break;
      case 'set_device_options':
        result = await this.mqtt.requestBridge('device/options', { id: args.id, options: args.options });
        break;
      case 'configure_device':
        result = await this.mqtt.requestBridge('device/configure', { id: args.id });
        break;
      case 'check_ota_updates':
        result = await this.mqtt.requestBridge('device/ota_update/check', { id: args.id }, 60000);
        break;
      case 'schedule_ota_update':
        result = await this.mqtt.requestBridge('device/ota_update/schedule', { id: args.id });
        break;
      case 'get_network_map':
        result = await this.mqtt.requestBridge('networkmap', { type: args.type || 'raw', routes: args.routes ?? false }, 120000);
        break;
      case 'check_bridge_health':
        result = await this.mqtt.requestBridge('health_check');
        break;
      case 'check_coordinator':
        result = await this.mqtt.requestBridge('coordinator_check');
        break;
      case 'restart_zigbee2mqtt':
        result = await this.mqtt.requestBridge('restart');
        break;
      case 'permit_join':
        result = await this.mqtt.requestBridge('permit_join', {
          time: args.enabled ? (args.timeout || 254) : 0,
          device: args.device,
        });
        break;
      default:
        throw new Error(`Unknown management tool: ${name}`);
    }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  }

  async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport);
  }
}
