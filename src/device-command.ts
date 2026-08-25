import { DeviceField } from './types.js';

export function validateDeviceCommand(fields: DeviceField[], command: unknown): asserts command is Record<string, unknown> {
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    throw new Error('command must be a JSON object');
  }
  const serialized = JSON.stringify(command);
  if (serialized.length > 16_384) throw new Error('command payload exceeds 16 KiB');
  const entries = Object.entries(command);
  if (entries.length === 0 || entries.length > 32) throw new Error('command must contain 1 to 32 properties');

  for (const [name, value] of entries) {
    const field = fields.find(candidate => candidate.field_name === name);
    if (!field) throw new Error(`Unknown command property: ${name}`);
    if (!field.access?.split(',').includes('write')) throw new Error(`Property is not writable: ${name}`);
    if (field.enum_values && !field.enum_values.includes(String(value))) {
      throw new Error(`${name} must be one of: ${field.enum_values.join(', ')}`);
    }
    if (field.field_type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
      if (field.value_min !== undefined && value < field.value_min) throw new Error(`${name} must be at least ${field.value_min}`);
      if (field.value_max !== undefined && value > field.value_max) throw new Error(`${name} must be at most ${field.value_max}`);
    }
    if (field.field_type === 'boolean' && !field.enum_values && typeof value !== 'boolean') {
      throw new Error(`${name} must be a boolean`);
    }
    if (field.field_type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) {
      throw new Error(`${name} must be an object`);
    }
  }
}
