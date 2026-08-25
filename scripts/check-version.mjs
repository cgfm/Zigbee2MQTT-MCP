import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
const packageLock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url)));
const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
const compose = readFileSync(new URL('../compose.yaml', import.meta.url), 'utf8');
const expected = process.argv[2]?.replace(/^v/, '') ?? packageJson.version;

assert.match(expected, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
assert.equal(packageJson.version, expected, 'package.json version differs');
assert.equal(packageLock.version, expected, 'package-lock.json top-level version differs');
assert.equal(packageLock.packages[''].version, expected, 'package-lock.json root package version differs');
assert.match(dockerfile, new RegExp(`ARG BUILD_VERSION=${expected.replaceAll('.', '\\.')}(?:\\n|$)`));
assert.match(compose, new RegExp(`ghcr\\.io/cgfm/zigbee2mqtt-mcp:${expected.replaceAll('.', '\\.')}`));

console.log(`Version sources agree on ${expected}`);
