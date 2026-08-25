import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AppConfig, loadConfig } from './config.js';
import { ZigbeeDatabase } from './database.js';
import { HttpService, startHttpServer } from './http-server.js';
import { logger } from './logger.js';
import { ZigbeeMcpServer } from './mcp-server.js';
import { MqttListener } from './mqtt-listener.js';

async function startStdioMode(config: AppConfig, db: ZigbeeDatabase, mqtt: MqttListener): Promise<void> {
  logger.debug('Starting in STDIO mode');
  const mcpServer = new ZigbeeMcpServer(db, mqtt, config.mqtt.baseTopic, {
    allowDestructive: config.allowDestructive,
  });
  await mcpServer.connect(new StdioServerTransport());
  logger.info('MCP server ready');
}

export async function main(): Promise<void> {
  const config = loadConfig();
  logger.setLevel(config.logLevel);
  logger.startup('=== Zigbee2MQTT MCP Server ===');
  for (const warning of config.warnings) logger.warn(warning);

  const db = new ZigbeeDatabase(config.dbPath);
  const mqtt = new MqttListener(config.mqtt, db);
  let httpService: HttpService | undefined;
  let shuttingDown = false;

  const shutdown = async (exitCode = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down...');
    const results = await Promise.allSettled([
      httpService?.close() ?? Promise.resolve(),
      mqtt.disconnect(),
    ]);
    for (const result of results) {
      if (result.status === 'rejected') logger.error('Shutdown step failed:', result.reason);
    }
    db.close();
    process.exitCode = exitCode;
  };

  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  try {
    await mqtt.connect();
    logger.info('MQTT connected');
    await new Promise(resolve => setTimeout(resolve, 2000));
    const stats = db.getStats();
    logger.startup(`Ready: ${stats.deviceCount} devices, ${stats.fieldCount} fields, ${stats.capabilityCount} capabilities`);
    if (config.transportMode === 'http') {
      httpService = await startHttpServer(config, db, mqtt);
    } else {
      await startStdioMode(config, db, mqtt);
    }
  } catch (error) {
    logger.error('Fatal error:', error instanceof Error ? error.message : String(error));
    await shutdown(1);
  }
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch(error => {
    logger.error('Unhandled error:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
