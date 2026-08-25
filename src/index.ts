import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import express, { NextFunction, Request, Response } from 'express';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { ZigbeeDatabase } from './database.js';
import { MqttListener, MqttConfig } from './mqtt-listener.js';
import { ZigbeeMcpServer } from './mcp-server.js';
import { logger } from './logger.js';

const config: MqttConfig = {
  brokerUrl: process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883',
  username: process.env.MQTT_USERNAME || undefined,
  password: process.env.MQTT_PASSWORD || undefined,
  baseTopic: process.env.MQTT_BASE_TOPIC || 'zigbee2mqtt',
};
const dbPath = process.env.DB_PATH || './zigbee2mqtt.db';
const transportMode = process.env.TRANSPORT_MODE || 'stdio';
const httpPort = Number.parseInt(process.env.HTTP_PORT || '3235', 10);
const httpHost = process.env.HTTP_HOST || '0.0.0.0';
const apiKey = process.env.API_KEY;
const sslEnabled = process.env.SSL_ENABLED === 'true';
const requestedMaxSessions = Number.parseInt(process.env.MAX_SESSIONS || '32', 10);
const maxSessions = Number.isFinite(requestedMaxSessions)
  ? Math.min(128, Math.max(1, requestedMaxSessions))
  : 32;
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean)
);

type HttpTransport = SSEServerTransport | StreamableHTTPServerTransport;

function constantTimeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

async function startStdioMode(db: ZigbeeDatabase, mqtt: MqttListener) {
  logger.debug('Starting in STDIO mode...');
  const mcpServer = new ZigbeeMcpServer(db, mqtt, config.baseTopic);
  await mcpServer.connect(new StdioServerTransport());
  logger.info('MCP Server ready');
}

async function startHttpMode(db: ZigbeeDatabase, mqtt: MqttListener) {
  if (!apiKey) throw new Error('API_KEY is required in HTTP mode');
  const app = express();
  const transports = new Map<string, HttpTransport>();
  const authFailures = new Map<string, { count: number; resetAt: number }>();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (!origin) return next();
    if (!allowedOrigins.has(origin)) {
      res.status(403).json({ error: 'Origin not allowed' });
      return;
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', mqtt_connected: mqtt.isConnected() });
  });

  app.use((req: Request, res: Response, next: NextFunction) => {
    const address = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const failure = authFailures.get(address);
    if (failure && failure.resetAt > now && failure.count >= 10) {
      res.setHeader('Retry-After', Math.ceil((failure.resetAt - now) / 1000));
      res.status(429).json({ error: 'Too many authentication failures' });
      return;
    }

    const match = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9._~+\/-]+=*)$/i);
    if (!match || !constantTimeEquals(match[1], apiKey)) {
      const current = failure && failure.resetAt > now ? failure : { count: 0, resetAt: now + 60000 };
      current.count++;
      authFailures.set(address, current);
      res.setHeader('WWW-Authenticate', 'Bearer');
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    authFailures.delete(address);
    next();
  });

  app.all('/mcp', async (req, res) => {
    try {
      const sessionId = typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : undefined;
      let transport: StreamableHTTPServerTransport;
      const existing = sessionId ? transports.get(sessionId) : undefined;

      if (existing instanceof StreamableHTTPServerTransport) {
        transport = existing;
      } else if (!sessionId && req.method === 'POST' && isInitializeRequest(req.body)) {
        if (transports.size >= maxSessions) {
          res.status(503).json({ error: 'Session limit reached' });
          return;
        }
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: id => {
            transports.set(id, transport);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) transports.delete(transport.sessionId);
        };
        await new ZigbeeMcpServer(db, mqtt, config.baseTopic).connect(transport);
      } else {
        res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Invalid or missing MCP session' }, id: null });
        return;
      }
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error('Streamable HTTP request failed:', error);
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.get('/sse', async (req, res) => {
    if (transports.size >= maxSessions) {
      res.status(503).json({ error: 'Session limit reached' });
      return;
    }
    const transport = new SSEServerTransport('/messages', res);
    transports.set(transport.sessionId, transport);
    res.on('close', () => transports.delete(transport.sessionId));
    try {
      await new ZigbeeMcpServer(db, mqtt, config.baseTopic).connect(transport);
    } catch (error) {
      transports.delete(transport.sessionId);
      logger.error('Failed to establish legacy SSE session:', error);
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.post('/messages', async (req, res) => {
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!(transport instanceof SSEServerTransport)) {
      res.status(404).json({ error: 'Unknown or expired SSE session' });
      return;
    }
    try {
      await transport.handlePostMessage(req, res, req.body);
    } catch (error) {
      logger.error('Legacy SSE message failed:', error);
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    }
  });

  const server = sslEnabled
    ? createHttpsServer({
        cert: readFileSync(process.env.SSL_CERTFILE || '/ssl/fullchain.pem'),
        key: readFileSync(process.env.SSL_KEYFILE || '/ssl/privkey.pem'),
      }, app)
    : createHttpServer(app);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(httpPort, httpHost, () => {
      const scheme = sslEnabled ? 'https' : 'http';
      logger.startup(`HTTP server listening on ${httpHost}:${httpPort}`);
      logger.info(`Streamable HTTP: ${scheme}://localhost:${httpPort}/mcp`);
      logger.info(`Legacy SSE: ${scheme}://localhost:${httpPort}/sse`);
      logger.info('Bearer authentication enabled');
      resolve();
    });
  });
}

async function main() {
  logger.startup('=== ZigBee2MQTT MCP Server ===');
  const db = new ZigbeeDatabase(dbPath);
  const mqtt = new MqttListener(config, db);
  try {
    await mqtt.connect();
    logger.info('MQTT connected');
    await new Promise(resolve => setTimeout(resolve, 2000));
    const stats = db.getStats();
    logger.startup(`Ready: ${stats.deviceCount} devices, ${stats.fieldCount} fields, ${stats.capabilityCount} capabilities`);
    if (transportMode === 'http') await startHttpMode(db, mqtt);
    else await startStdioMode(db, mqtt);

    const shutdown = async () => {
      logger.info('Shutting down...');
      await mqtt.disconnect();
      db.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (error) {
    logger.error('Fatal error:', error);
    await mqtt.disconnect();
    db.close();
    process.exit(1);
  }
}

main().catch(error => {
  logger.error('Unhandled error:', error);
  process.exit(1);
});
