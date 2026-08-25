import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { loadConfig } from './config.js';

const config = loadConfig();
if (config.transportMode !== 'http') process.exit(0);

const request = config.sslEnabled ? httpsRequest : httpRequest;
const client = request({
  host: config.httpHost === '0.0.0.0' || config.httpHost === '::' ? '127.0.0.1' : config.httpHost,
  port: config.httpPort,
  path: '/health',
  method: 'GET',
  rejectUnauthorized: false,
  timeout: 3000,
}, response => {
  response.resume();
  process.exit(response.statusCode === 200 ? 0 : 1);
});
client.once('timeout', () => client.destroy(new Error('Health request timed out')));
client.once('error', () => process.exit(1));
client.end();
