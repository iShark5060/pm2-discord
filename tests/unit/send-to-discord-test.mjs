import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildWebhookPayload, embedTimestamp, eventEmbedStyle } from '../../dist/send-to-discord.mjs';

test('eventEmbedStyle: maps known events to title and color', () => {
  assert.deepEqual(eventEmbedStyle('error'), { title: 'Error', color: 0xcb2431 });
  assert.deepEqual(eventEmbedStyle('restart'), { title: 'Restart', color: 0xdbab09 });
  assert.deepEqual(eventEmbedStyle('log'), { title: 'Log', color: 0x0366d6 });
  assert.deepEqual(eventEmbedStyle('send_failed'), { title: 'Send failed', color: 0xdbab09 });
});

test('eventEmbedStyle: capitalizes unknown events', () => {
  assert.equal(eventEmbedStyle('custom').title, 'Custom');
  assert.equal(eventEmbedStyle('').title, 'Event');
});

test('embedTimestamp: uses unix seconds when present', () => {
  assert.equal(embedTimestamp(1_700_000_000, 0), new Date(1_700_000_000 * 1000).toISOString());
});

test('embedTimestamp: falls back to send time', () => {
  const sentAt = Date.parse('2026-09-15T02:00:00.000Z');
  assert.equal(embedTimestamp(null, sentAt), '2026-09-15T02:00:00.000Z');
});

test('buildWebhookPayload: posts an embed instead of content', () => {
  const sentAt = Date.parse('2026-09-15T02:00:00.000Z');
  const payload = buildWebhookPayload(
    [
      {
        name: 'api',
        event: 'error',
        description: 'boom',
        timestamp: 1_700_000_000,
      },
    ],
    sentAt,
  );

  assert.equal(payload.username, 'api');
  assert.equal(payload.embeds.length, 1);
  assert.equal(payload.embeds[0].title, 'Error');
  assert.equal(payload.embeds[0].color, 0xcb2431);
  assert.equal(payload.embeds[0].description, 'boom');
  assert.equal(payload.embeds[0].timestamp, new Date(1_700_000_000 * 1000).toISOString());
  assert.equal('content' in payload, false);
});
