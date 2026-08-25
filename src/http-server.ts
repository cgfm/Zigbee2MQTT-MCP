import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer, Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import express, { NextFunction, Request, Response } from 'express';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { AppConfig } from './config.js';
import { ZigbeeDatabase } from './database.js';
import { logger } from './logger.js';
import { ZigbeeMcpServer } from './mcp-server.js';
import { MqttListener } from './mqtt-listener.js';

type HttpTransport = SSEServerTransport | StreamableHTTPServerTransport;

export interface HttpService {
  close(): Promise<void>;
  port: number;
  sessionCount(): number;
}

export function constantTimeTokenEquals(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function closeServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

export async function startHttpServer(
  config: AppConfig,
  db: ZigbeeDatabase,
  mqtt: MqttListener,
): Promise<HttpService> {
  if (!config.apiKey) throw new Error('API_KEY is required in HTTP mode');

  const app = express();
  const transports = new Map<string, HttpTransport>();
  const authFailures = new Map<string, { count: number; resetAt: number }>();
  const allowedOrigins = new Set(config.allowedOrigins);
  let openingSessions = 0;
  let closing = false;

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
    res.json({ status: closing ? 'stopping' : 'ok', mqtt_connected: mqtt.isConnected() });
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
    if (!match || !constantTimeTokenEquals(match[1], config.apiKey!)) {
      const current = failure && failure.resetAt > now ? failure : { count: 0, resetAt: now + 60_000 };
      current.count++;
      authFailures.set(address, current);
      if (authFailures.size > 1024) {
        for (const [key, value] of authFailures) {
          if (value.resetAt <= now) authFailures.delete(key);
        }
      }
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
        if (transports.size + openingSessions >= config.maxSessions) {
          res.status(503).json({ error: 'Session limit reached' });
          return;
        }
        openingSessions++;
        try {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: id => {
              transports.set(id, transport);
            },
          });
          transport.onclose = () => {
            if (transport.sessionId) transports.delete(transport.sessionId);
          };
          await new ZigbeeMcpServer(db, mqtt, config.mqtt.baseTopic, {
            allowDestructive: config.allowDestructive,
          }).connect(transport);
        } finally {
          openingSessions--;
        }
      } else {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Invalid or missing MCP session' },
          id: null,
        });
        return;
      }
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error('Streamable HTTP request failed:', error);
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.get('/sse', async (_req, res) => {
    if (transports.size + openingSessions >= config.maxSessions) {
      res.status(503).json({ error: 'Session limit reached' });
      return;
    }
    openingSessions++;
    const transport = new SSEServerTransport('/messages', res);
    transports.set(transport.sessionId, transport);
    res.on('close', () => transports.delete(transport.sessionId));
    try {
      await new ZigbeeMcpServer(db, mqtt, config.mqtt.baseTopic, {
        allowDestructive: config.allowDestructive,
      }).connect(transport);
    } catch (error) {
      transports.delete(transport.sessionId);
      logger.error('Failed to establish legacy SSE session:', error);
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    } finally {
      openingSessions--;
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

  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(error);
    const status = typeof error === 'object' && error && 'status' in error && error.status === 413 ? 413 : 400;
    res.status(status).json({ error: status === 413 ? 'Request body too large' : 'Invalid JSON request body' });
  });

  const server = config.sslEnabled
    ? createHttpsServer({
        cert: readFileSync(config.sslCertFile),
        key: readFileSync(config.sslKeyFile),
      }, app)
    : createHttpServer(app);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.httpPort, config.httpHost, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.httpPort;
  const scheme = config.sslEnabled ? 'https' : 'http';
  logger.startup(`HTTP server listening on ${config.httpHost}:${port}`);
  logger.info(`Streamable HTTP: ${scheme}://localhost:${port}/mcp`);
  logger.info(`Legacy SSE: ${scheme}://localhost:${port}/sse`);
  logger.info('Bearer authentication enabled');

  return {
    port,
    sessionCount: () => transports.size,
    async close() {
      if (closing) return;
      closing = true;
      await Promise.allSettled([...transports.values()].map(transport => transport.close()));
      transports.clear();
      await closeServer(server);
    },
  };
}
