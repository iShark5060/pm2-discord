import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  checkProcessName,
  fitDiscordPayload,
  messageFingerprint,
  parseIncomingLog,
  parseProcessName,
} from '../../dist/log-utils.mjs';

// ===== parseIncomingLog TESTS =====
test('parseIncomingLog: extracts timestamp from standard PM2 log format', async () => {
  const result = await parseIncomingLog('2026-01-23 10:30:45 +00:00: Server started');
  assert.ok(result.timestamp > 0, 'timestamp should be extracted');
  assert.strictEqual(result.description, 'Server started', 'description should have date removed');
});

test('parseIncomingLog: handles log without timestamp', async () => {
  const result = await parseIncomingLog('Simple log message');
  assert.ok(result.timestamp === null || result.timestamp === undefined, 'timestamp should be null');
  assert.strictEqual(result.description, 'Simple log message', 'description should be the whole message');
});

test('parseIncomingLog: does not wrap as a code block', async () => {
  const result = await parseIncomingLog('Simple log message');
  assert.strictEqual(result.description, 'Simple log message', 'ingest should stay unformatted');
});

test('parseIncomingLog: handles empty string', async () => {
  const result = await parseIncomingLog('');
  assert.strictEqual(result.description, '', 'should handle empty string');
});

test('parseIncomingLog: handles log with multiple colons in content', async () => {
  const result = await parseIncomingLog('2026-01-23 10:30:45 +00:00: Server error: Connection refused');
  assert.ok(result.timestamp > 0, 'should still extract timestamp');
  assert.strictEqual(result.description, 'Server error: Connection refused', 'should preserve message content');
});

test('parseIncomingLog: handles non-string input', async () => {
  const result = await parseIncomingLog(null);
  assert.strictEqual(result.description, null, 'should return null for non-string input');
});

test('parseIncomingLog: handles timestamp with milliseconds', async () => {
  const result = await parseIncomingLog('2026-01-23 10:30:45.123 +00:00: Server started');
  assert.ok(result.timestamp > 0, 'should extract timestamp with milliseconds');
  assert.strictEqual(result.description, 'Server started', 'should preserve message');
});

test('parseIncomingLog: handles negative timezone offset', async () => {
  const result = await parseIncomingLog('2026-01-23 10:30:45 -05:00: Server started');
  assert.ok(result.timestamp > 0, 'should handle negative timezone offset');
  assert.strictEqual(result.description, 'Server started', 'should preserve message');
});

test('parseIncomingLog: strips ANSI color codes', async () => {
  const ansiRed = '\u001b[31m';
  const ansiReset = '\u001b[0m';
  const input = `2026-01-23 10:30:45 +00:00: ${ansiRed}Error occurred${ansiReset}`;
  const result = await parseIncomingLog(input);
  assert.strictEqual(result.description, 'Error occurred', 'should strip ANSI color codes from description');
});

// ===== parseProcessName TESTS =====
test('parseProcessName: returns simple name for fork mode', () => {
  const process = { name: 'api', exec_mode: 'fork_mode', instances: 1, pm_id: 0 };
  const result = parseProcessName(process);
  assert.strictEqual(result, 'api', 'should return name without suffix for fork mode');
});

test('parseProcessName: returns name with pm_id for cluster mode with multiple instances', () => {
  const process = { name: 'api', exec_mode: 'cluster_mode', instances: 4, pm_id: 2 };
  const result = parseProcessName(process);
  assert.strictEqual(result, 'api[2]', 'should append [pm_id] for cluster mode with multiple instances');
});

test('parseProcessName: returns simple name for cluster mode with single instance', () => {
  const process = { name: 'worker', exec_mode: 'cluster_mode', instances: 1, pm_id: 0 };
  const result = parseProcessName(process);
  assert.strictEqual(result, 'worker', 'should not append suffix when instances = 1');
});

test('parseProcessName: handles hyphenated process names', () => {
  const process = { name: 'my-api-service', exec_mode: 'fork_mode', instances: 1, pm_id: 0 };
  const result = parseProcessName(process);
  assert.strictEqual(result, 'my-api-service', 'should preserve hyphenated names');
});

test('parseProcessName: handles numeric process names', () => {
  const process = { name: '123', exec_mode: 'fork_mode', instances: 1, pm_id: 0 };
  const result = parseProcessName(process);
  assert.strictEqual(result, '123', 'should handle numeric names');
});

test('parseProcessName: cluster mode with pm_id 0', () => {
  const process = { name: 'app', exec_mode: 'cluster_mode', instances: 4, pm_id: 0 };
  const result = parseProcessName(process);
  assert.strictEqual(result, 'app[0]', 'should append [0] for first cluster instance');
});

// ===== checkProcessName TESTS =====
test('checkProcessName: filters out pm2-discord process', () => {
  const data = { process: { name: 'pm2-discord' } };
  const result = checkProcessName(data);
  assert.strictEqual(result, false, 'should filter out pm2-discord');
});

test('checkProcessName: returns true for other processes', () => {
  const data = { process: { name: 'api' } };
  const result = checkProcessName(data);
  assert.strictEqual(result, true, 'should return true for non-pm2-discord processes');
});

test('checkProcessName: null process name', () => {
  const data = { process: { name: null } };
  const result = checkProcessName(data);
  assert.strictEqual(result, true, 'should allow null process names');
});

test('checkProcessName: undefined process name', () => {
  const data = { process: { name: undefined } };
  const result = checkProcessName(data);
  assert.strictEqual(result, true, 'should allow undefined process names');
});

test('checkProcessName: empty string process name', () => {
  const data = { process: { name: '' } };
  const result = checkProcessName(data);
  assert.strictEqual(result, true, 'should allow empty string process names');
});

test('fitDiscordPayload: keeps closing fence when truncating a code block', () => {
  const body = 'x'.repeat(5000);
  const result = fitDiscordPayload(body, 1, true);
  assert.ok(result.startsWith('```'), 'should open a code fence');
  assert.ok(result.endsWith('```'), 'should close the code fence');
  assert.ok(result.length <= 2000, 'should stay within Discord limit');
  assert.ok(result.includes('...'), 'should mark truncation');
});

test('fitDiscordPayload: puts repeat count outside the fence', () => {
  const result = fitDiscordPayload('boom', 6, true);
  assert.strictEqual(result, '```boom```\n[5 more entries]');
  assert.ok(result.length <= 2000);
});

test('fitDiscordPayload: truncates body to leave room for suffix and fences', () => {
  const result = fitDiscordPayload('y'.repeat(5000), 12, true);
  assert.ok(result.startsWith('```'));
  assert.ok(result.includes('```\n[11 more entries]'));
  assert.ok(result.endsWith('[11 more entries]'));
  assert.ok(result.length <= 2000);
});

test('messageFingerprint: treats timestamps as noise', () => {
  const a = messageFingerprint('api', 'error', '2026-09-13 00:31:40 +02:00: getaddrinfo EAI_AGAIN');
  const b = messageFingerprint('api', 'error', '2026-09-13 00:35:01 +02:00: getaddrinfo EAI_AGAIN');
  assert.strictEqual(a, b, 'same error with different timestamps should match');
});

test('messageFingerprint: different text does not match', () => {
  const a = messageFingerprint('api', 'error', 'getaddrinfo EAI_AGAIN');
  const b = messageFingerprint('api', 'error', 'connection refused');
  assert.notStrictEqual(a, b);
});
