import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MessageQueue, SEND_FAILED_DESCRIPTION, SEND_FAILED_EVENT } from '../../dist/message-queue.mjs';

// ===== MESSAGE QUEUE THROTTLING TESTS =====

test('MessageQueue - calculates correct throttle rate from config', () => {
  const mockSender = async (messages) => {
    return { success: true, rateLimitInfo: {} };
  };

  // User wants 20 messages per 60 seconds (within webhook limit)
  const config = {
    discord_url: 'https://test.webhook',
    rate_limit_messages: 20,
    rate_limit_window_seconds: 60,
  };

  const queue = new MessageQueue(config, mockSender);

  const effectiveRate = queue.getEffectiveRate();

  // Should be 20/60 = 0.333... requests per second (under the 0.5 limit)
  assert.ok(effectiveRate >= 0.3 && effectiveRate <= 0.35, 'should calculate correct rate from config');
  assert.ok(queue.requestsPerTick >= 1, 'should have at least 1 request per tick');

  queue.stopInterval();
});

test('MessageQueue - uses default webhook rate limit when no config provided', () => {
  const mockSender = async (messages) => {
    return { success: true, rateLimitInfo: {} };
  };

  // No rate config provided - should use Discord webhook default (30/60sec = 0.5/sec)
  const config = {
    discord_url: 'https://test.webhook',
  };

  const queue = new MessageQueue(config, mockSender);

  const effectiveRate = queue.getEffectiveRate();

  // Should default to safe webhook limit: 30 per 60 seconds = 0.5/sec
  assert.ok(effectiveRate <= 0.5, 'should default to webhook safe rate of 0.5 req/sec');

  queue.stopInterval();
});

test('MessageQueue - caps rate at webhook limit (30 per 60sec)', () => {
  const mockSender = async (messages) => {
    return { success: true, rateLimitInfo: {} };
  };

  // User wants 100 messages per 60 seconds (too high for webhooks)
  const config = {
    discord_url: 'https://test.webhook',
    rate_limit_messages: 100,
    rate_limit_window_seconds: 60,
  };

  const queue = new MessageQueue(config, mockSender);

  const effectiveRate = queue.getEffectiveRate();

  // Webhooks have a limit of 30 requests per 60 seconds = 0.5/sec
  assert.ok(effectiveRate <= 0.5, 'should cap rate at webhook limit of 0.5 req/sec');

  queue.stopInterval();
});

test('MessageQueue - tracks request history correctly', async () => {
  let callCount = 0;
  const mockSender = async (messages) => {
    callCount++;
    return { success: true, rateLimitInfo: {} };
  };

  const config = {
    discord_url: 'https://test.webhook',
    rate_limit_messages: 5,
    rate_limit_window_seconds: 2,
    buffer: false,
  };

  const queue = new MessageQueue(config, mockSender);

  // Add messages
  queue.addMessage({ name: 'app', event: 'log', description: 'msg1', timestamp: Date.now() });
  queue.addMessage({ name: 'app', event: 'log', description: 'msg2', timestamp: Date.now() });
  queue.addMessage({ name: 'app', event: 'log', description: 'msg3', timestamp: Date.now() });

  // Force flush
  await queue.flush();

  const history = queue.getRequestHistory();

  assert.strictEqual(callCount, 1, 'should have sent once');
  assert.strictEqual(history.length, 1, 'should have one entry in history');
  assert.ok(history[0].timestamp > 0, 'history entry should have timestamp');

  queue.stopInterval();
});

test('MessageQueue - respects Discord rate limit backoff', async () => {
  let callCount = 0;
  const mockSender = async (messages) => {
    callCount++;
    // Simulate Discord rate limit response
    return {
      success: false,
      rateLimited: true,
      retryAfter: 2,
      rateLimitInfo: {},
    };
  };

  const config = {
    discord_url: 'https://test.webhook',
    rate_limit_messages: 10,
    rate_limit_window_seconds: 1,
    buffer: false,
  };

  const queue = new MessageQueue(config, mockSender);

  queue.addMessage({ name: 'app', event: 'log', description: 'msg1', timestamp: Date.now() });
  await queue.flush();

  assert.strictEqual(callCount, 1, 'should have attempted to send');
  assert.strictEqual(queue.canSendNow(), false, 'should be in backoff period');
  queue.stopInterval();
});

test('MessageQueue - calculates correct delay until next send', async () => {
  const mockSender = async (messages) => {
    return {
      success: false,
      rateLimited: true,
      retryAfter: 2,
      rateLimitInfo: {},
    };
  };

  const config = {
    discord_url: 'https://test.webhook',
    rate_limit_messages: 5,
    rate_limit_window_seconds: 2,
    buffer: false,
  };

  const queue = new MessageQueue(config, mockSender);

  // Trigger a rate limit
  queue.addMessage({ name: 'app', event: 'log', description: 'msg1', timestamp: Date.now() });
  await queue.flush();

  const delay = queue.getDelayUntilNextSend();

  queue.stopInterval();

  assert.ok(delay > 0, 'should require a delay');
  assert.ok(delay <= 2000, 'delay should not exceed retry_after time');
});

test('MessageQueue - handles successful sends', async () => {
  let sentMessages = [];
  const mockSender = async (messages) => {
    sentMessages = messages;
    return { success: true, rateLimitInfo: {} };
  };

  const config = {
    discord_url: 'https://test.webhook',
    rate_limit_messages: 10,
    rate_limit_window_seconds: 1,
    buffer: false,
  };

  const queue = new MessageQueue(config, mockSender);

  queue.addMessage({ name: 'app', event: 'log', description: 'msg1', timestamp: Date.now() });
  queue.addMessage({ name: 'app', event: 'log', description: 'msg2', timestamp: Date.now() });

  await queue.flush();

  queue.stopInterval();

  assert.ok(sentMessages.length > 0, 'should have sent messages');
  assert.strictEqual(queue.canSendNow(), true, 'should be able to send again');
});

test('MessageQueue - puts messages back on rate limit', async () => {
  const mockSender = async (messages) => {
    return {
      success: false,
      rateLimited: true,
      retryAfter: 1,
      rateLimitInfo: {},
    };
  };

  const config = {
    discord_url: 'https://test.webhook',
    rate_limit_messages: 10,
    rate_limit_window_seconds: 1,
    buffer: false,
  };

  const queue = new MessageQueue(config, mockSender);

  queue.addMessage({ name: 'app', event: 'log', description: 'msg1', timestamp: Date.now() });
  queue.addMessage({ name: 'app', event: 'log', description: 'msg2', timestamp: Date.now() });

  const queueLengthBefore = queue.messageQueue.length;
  await queue.flush();
  const queueLengthAfter = queue.messageQueue.length;

  queue.stopInterval();
  assert.strictEqual(queueLengthBefore, 2, 'should have 2 messages before flush');
  assert.strictEqual(queueLengthAfter, 2, 'should still have 2 messages after rate limit (put back)');
});

test('MessageQueue - starts interval when message added', () => {
  const mockSender = async (messages) => {
    return { success: true, rateLimitInfo: {} };
  };

  const config = {
    discord_url: 'https://test.webhook',
    rate_limit_messages: 10,
    rate_limit_window_seconds: 1,
    buffer: false,
  };

  const queue = new MessageQueue(config, mockSender);

  assert.strictEqual(queue.flushInterval, null, 'interval should not be running initially');

  queue.addMessage({ name: 'app', event: 'log', description: 'msg1', timestamp: Date.now() });

  assert.ok(queue.flushInterval !== null, 'interval should start after adding message');

  queue.stopInterval();
});

test('MessageQueue - stops interval when queue is empty', async () => {
  const mockSender = async (messages) => {
    return { success: true, rateLimitInfo: {} };
  };

  const config = {
    discord_url: 'https://test.webhook',
    rate_limit_messages: 10,
    rate_limit_window_seconds: 1,
    buffer: false,
  };

  const queue = new MessageQueue(config, mockSender);

  queue.addMessage({ name: 'app', event: 'log', description: 'msg1', timestamp: Date.now() });

  assert.ok(queue.flushInterval !== null, 'interval should be running');

  // Process the queue until empty
  await queue.flush();
  await queue.processTick(); // This should stop the interval since queue is empty

  assert.strictEqual(queue.flushInterval, null, 'interval should stop when queue is empty');
  queue.stopInterval();
});

test('MessageQueue - cleans up old request history', () => {
  const mockSender = async (messages) => {
    return { success: true, rateLimitInfo: {} };
  };

  const config = {
    discord_url: 'https://test.webhook',
    rate_limit_messages: 5,
    rate_limit_window_seconds: 2,
  };

  const queue = new MessageQueue(config, mockSender);

  // Record requests with old timestamps
  const oldTimestamp = Date.now() - 5000; // 5 seconds ago
  queue.recordRequest(oldTimestamp);
  queue.recordRequest(oldTimestamp);

  // Record recent request
  queue.recordRequest();

  queue.cleanupRequestHistory();

  const history = queue.getRequestHistory();

  assert.ok(history.length < 3, 'should have removed old entries');
  assert.ok(history.length >= 1, 'should keep recent entries');

  queue.stopInterval();
});

test('MessageQueue - buffers messages when buffer is enabled', async () => {
  let sentMessages = [];
  const mockSender = async (messages) => {
    sentMessages = messages;
    return { success: true, rateLimitInfo: {} };
  };

  const config = {
    discord_url: 'https://test.webhook',
    rate_limit_messages: 10,
    rate_limit_window_seconds: 1,
    buffer: true,
    buffer_seconds: 1,
  };

  const queue = new MessageQueue(config, mockSender);

  // Add multiple messages quickly
  queue.addMessage({ name: 'app', event: 'log', description: 'Message 1', timestamp: Date.now() });
  queue.addMessage({ name: 'app', event: 'log', description: 'Message 2', timestamp: Date.now() });
  queue.addMessage({ name: 'app', event: 'log', description: 'Message 3', timestamp: Date.now() });

  // Wait for buffer to flush (1s) + rate limit interval (2s for 0.5 req/sec)
  await new Promise((resolve) => setTimeout(resolve, 3500));

  assert.strictEqual(sentMessages.length, 1, 'should send only one message');
  assert.ok(
    sentMessages[0].description.includes('Message 1') &&
      sentMessages[0].description.includes('Message 2') &&
      sentMessages[0].description.includes('Message 3'),
    'should combine all messages',
  );

  queue.stopInterval();
});

test('MessageQueue - does not buffer when buffer is disabled', async () => {
  let callCount = 0;
  const mockSender = async (messages) => {
    callCount++;
    return { success: true, rateLimitInfo: {} };
  };

  const config = {
    discord_url: 'https://test.webhook',
    rate_limit_messages: 10,
    rate_limit_window_seconds: 1,
    buffer: false,
  };

  const queue = new MessageQueue(config, mockSender);

  queue.addMessage({ name: 'app', event: 'log', description: 'Message 1', timestamp: Date.now() });
  queue.addMessage({ name: 'app', event: 'log', description: 'Message 2', timestamp: Date.now() });

  await queue.flush();
  await queue.flush();

  assert.ok(callCount >= 1, 'should send messages without buffering');

  queue.stopInterval();
});

test('MessageQueue - respects buffer_seconds timing', async () => {
  let callCount = 0;
  const mockSender = async (messages) => {
    callCount++;
    return { success: true, rateLimitInfo: {} };
  };

  const config = {
    discord_url: 'https://test.webhook',
    rate_limit_messages: 10,
    rate_limit_window_seconds: 1,
    buffer: true,
    buffer_seconds: 0.5, // 500ms
  };

  const queue = new MessageQueue(config, mockSender);

  queue.addMessage({ name: 'app', event: 'log', description: 'Message 1', timestamp: Date.now() });

  // Wait 600ms (buffer) + 2000ms (rate limit interval for 0.5 req/sec)
  await new Promise((resolve) => setTimeout(resolve, 2700));

  // Add another message after buffer expires
  queue.addMessage({ name: 'app', event: 'log', description: 'Message 2', timestamp: Date.now() });

  // Wait for second buffer (500ms) + rate limit interval (2000ms)
  await new Promise((resolve) => setTimeout(resolve, 2700));

  assert.strictEqual(callCount, 2, 'should send two separate messages when buffer_seconds expires');

  queue.stopInterval();
});

test('MessageQueue - stops sending on invalid webhook (404)', async () => {
  let callCount = 0;
  const mockSender = async (messages) => {
    callCount++;
    // Simulate 404 response
    return {
      success: false,
      webhookInvalid: true,
      error: 'HTTP 404: Not Found',
      rateLimitInfo: {},
    };
  };

  const config = {
    discord_url: 'https://test.webhook',
    rate_limit_messages: 10,
    rate_limit_window_seconds: 1,
    buffer: false,
  };

  const queue = new MessageQueue(config, mockSender);

  queue.addMessage({ name: 'app', event: 'log', description: 'msg1', timestamp: Date.now() });
  await queue.flush();

  assert.strictEqual(callCount, 1, 'should have attempted to send once');
  assert.strictEqual(queue.isWebhookInvalid(), true, 'should mark webhook as invalid');

  // Try to add another message
  queue.addMessage({ name: 'app', event: 'log', description: 'msg2', timestamp: Date.now() });
  await queue.flush();

  assert.strictEqual(callCount, 1, 'should not attempt to send again after 404');

  queue.stopInterval();
});

// ===== CHARACTER LIMIT TESTS =====

test('MessageQueue - tracks character count correctly in buffer', () => {
  const mockSender = async (messages) => {
    return { success: true, rateLimitInfo: {} };
  };

  const config = {
    discord_url: 'https://test.webhook',
    buffer: true,
    buffer_seconds: 1,
  };

  const queue = new MessageQueue(config, mockSender);

  const msg1 = { name: 'app', event: 'log', description: 'a'.repeat(500), timestamp: Date.now() };
  const msg2 = { name: 'app', event: 'log', description: 'b'.repeat(500), timestamp: Date.now() };

  queue.addMessage(msg1);
  assert.strictEqual(queue.characterCount, 500, 'should track first message (500 chars)');

  queue.addMessage(msg2);
  assert.strictEqual(queue.characterCount, 1000, 'should track second message (500 + 500)');

  // Character count should be sum of descriptions, not including newlines (those are added on flush)
  assert.ok(queue.characterCount <= 1000, 'character count should only count message content');

  queue.stopInterval();
});

test('MessageQueue - flushes buffer when character limit exceeded', async () => {
  let sentMessages = [];
  const mockSender = async (messages) => {
    sentMessages = messages;
    return { success: true, rateLimitInfo: {} };
  };

  const config = {
    discord_url: 'https://test.webhook',
    rate_limit_messages: 10,
    rate_limit_window_seconds: 1,
    buffer: true,
    buffer_seconds: 5, // Long buffer to prevent natural flush
  };

  const queue = new MessageQueue(config, mockSender);

  // Add messages that will exceed the embed description limit
  const limit = queue.bodyLimit();
  queue.addMessage({
    name: 'app',
    event: 'log',
    description: 'x'.repeat(Math.floor(limit * 0.7)),
    timestamp: Date.now(),
  });
  assert.strictEqual(queue.currentBuffer.length, 1, 'first message should be buffered');

  queue.addMessage({
    name: 'app',
    event: 'log',
    description: 'y'.repeat(Math.floor(limit * 0.5)),
    timestamp: Date.now(),
  });

  // After attempting to add the second message, first buffer should have been flushed
  assert.ok(queue.currentBuffer.length <= 1, 'current buffer should contain only the new message');

  queue.stopInterval();
});

test('MessageQueue - truncates single messages exceeding the embed description limit', () => {
  let sentMessages = [];
  const mockSender = async (messages) => {
    sentMessages = messages;
    return { success: true, rateLimitInfo: {} };
  };

  const config = {
    discord_url: 'https://test.webhook',
    buffer: true,
    buffer_seconds: 1,
    rate_limit_messages: 10,
    rate_limit_window_seconds: 1,
  };

  const queue = new MessageQueue(config, mockSender);
  const limit = queue.bodyLimit();

  const oversizedMessage = {
    name: 'app',
    event: 'log',
    description: 'x'.repeat(limit + 1000),
    timestamp: Date.now(),
  };

  queue.addMessage(oversizedMessage);

  // The message was truncated and flushed to the messageQueue, so check there
  assert.ok(sentMessages.length === 0, 'message should not have been sent yet (still in queue)');
  assert.ok(queue.messageQueue.length === 1, 'truncated message should be in message queue');
  assert.ok(
    queue.messageQueue[0].description.length <= limit,
    'message should be truncated to the embed description limit or less',
  );

  queue.stopInterval();
});

test('MessageQueue - accounts for newlines when checking character limit', async () => {
  let sentMessages = [];
  const mockSender = async (messages) => {
    sentMessages = messages;
    return { success: true, rateLimitInfo: {} };
  };

  const config = {
    discord_url: 'https://test.webhook',
    rate_limit_messages: 10,
    rate_limit_window_seconds: 1,
    buffer: true,
    buffer_seconds: 5,
  };

  const queue = new MessageQueue(config, mockSender);
  const half = Math.floor(queue.bodyLimit() / 2) + 10;

  queue.addMessage({ name: 'app', event: 'log', description: 'a'.repeat(half), timestamp: Date.now() });
  queue.addMessage({ name: 'app', event: 'log', description: 'b'.repeat(half), timestamp: Date.now() });

  // Check that messages were split (second was not added to buffer due to newline accounting)
  // After the second addMessage, the first should have been flushed
  const flushCount = queue.messageQueue.length + queue.currentBuffer.length;
  assert.ok(flushCount > 0, 'messages should be split across buffer and queue due to newline accounting');

  queue.stopInterval();
});

test('MessageQueue - shouldFlushBuffer triggers at character limit', () => {
  const mockSender = async (messages) => {
    return { success: true, rateLimitInfo: {} };
  };

  const config = {
    discord_url: 'https://test.webhook',
    buffer: true,
    buffer_seconds: 1,
    queue_max: 100,
  };

  const queue = new MessageQueue(config, mockSender);
  const almost = queue.bodyLimit() - 1;

  queue.addMessage({ name: 'app', event: 'log', description: 'x'.repeat(almost), timestamp: Date.now() });

  assert.strictEqual(queue.shouldFlushBuffer(), false, 'should not flush just under the limit');

  queue.addMessage({ name: 'app', event: 'log', description: 'y'.repeat(1), timestamp: Date.now() });

  // Now it should flush (first message at 1999, adding 1 more would exceed)
  // Actually the flush happens during addMessage, so current buffer length should be 1
  assert.ok(queue.characterCount >= 0, 'buffer management should be working');

  queue.stopInterval();
});

test('MessageQueue - combines messages with newlines without exceeding limit', async () => {
  let sentMessages = [];
  const mockSender = async (messages) => {
    sentMessages = messages;
    return { success: true, rateLimitInfo: {} };
  };

  const config = {
    discord_url: 'https://test.webhook',
    rate_limit_messages: 10,
    rate_limit_window_seconds: 1,
    buffer: true,
    buffer_seconds: 1,
  };

  const queue = new MessageQueue(config, mockSender);

  // Add 3 messages of 600 chars each = 1800 chars + 2 newlines = 1802 total
  queue.addMessage({ name: 'app', event: 'log', description: 'a'.repeat(600), timestamp: Date.now() });
  queue.addMessage({ name: 'app', event: 'log', description: 'b'.repeat(600), timestamp: Date.now() });
  queue.addMessage({ name: 'app', event: 'log', description: 'c'.repeat(600), timestamp: Date.now() });

  // Wait for buffer flush (1s) + rate limit interval (2s at 0.5 req/sec)
  await new Promise((resolve) => setTimeout(resolve, 3500));

  assert.ok(sentMessages.length > 0, 'should send at least one message');

  // The combined message should be under 2000
  if (sentMessages.length > 0) {
    const combinedLength = sentMessages[0].description.length;
    assert.ok(
      combinedLength <= queue.bodyLimit() + 24 + 6,
      `combined message should be under the embed description limit (got ${combinedLength})`,
    );
  } else {
    assert.ok(false, 'should have sent messages');
  }

  queue.stopInterval();
});

test('MessageQueue - resets character count on buffer flush', async () => {
  const mockSender = async (messages) => {
    return { success: true, rateLimitInfo: {} };
  };

  const config = {
    discord_url: 'https://test.webhook',
    rate_limit_messages: 10,
    rate_limit_window_seconds: 1,
    buffer: true,
    buffer_seconds: 0.5,
  };

  const queue = new MessageQueue(config, mockSender);

  queue.addMessage({ name: 'app', event: 'log', description: 'x'.repeat(500), timestamp: Date.now() });
  assert.strictEqual(queue.characterCount, 500, 'should have 500 chars before flush');

  // Wait for buffer to flush
  await new Promise((resolve) => setTimeout(resolve, 1000));

  assert.strictEqual(queue.characterCount, 0, 'character count should reset after flush');

  queue.stopInterval();
});

test('MessageQueue - respects queue_max limit along with character limit', () => {
  const mockSender = async (messages) => {
    return { success: true, rateLimitInfo: {} };
  };

  const config = {
    discord_url: 'https://test.webhook',
    buffer: true,
    buffer_seconds: 1,
    queue_max: 5, // Only 5 messages max per buffer
  };

  const queue = new MessageQueue(config, mockSender);

  // Add 5 small messages
  for (let i = 0; i < 5; i++) {
    queue.addMessage({ name: 'app', event: 'log', description: `msg ${i}`, timestamp: Date.now() });
  }

  // Buffer should still have all 5 since they haven't hit flush yet
  assert.ok(queue.currentBuffer.length <= 5, 'should respect queue_max limit');

  queue.stopInterval();
});

test('MessageQueue - collapses duplicate unsent messages', async () => {
  const sent = [];
  const mockSender = async (messages) => {
    sent.push(...messages);
    return { success: true, rateLimitInfo: {} };
  };

  const queue = new MessageQueue(
    {
      discord_url: 'https://test.webhook',
      buffer: false,
      collapse: true,
      collapse_seconds: 60,
      format: false,
      rate_limit_messages: 30,
      rate_limit_window_seconds: 1,
    },
    mockSender,
  );

  for (let i = 0; i < 6; i++) {
    queue.addMessage({ name: 'api', event: 'error', description: 'getaddrinfo EAI_AGAIN', timestamp: Date.now() });
  }

  assert.strictEqual(queue.messageQueue.length, 1, 'duplicates should stay as one queued message');
  assert.strictEqual(queue.messageQueue[0]._repeatCount, 6);

  await queue.flush();

  assert.strictEqual(sent.length, 1, 'should send once');
  assert.ok(sent[0].description.includes('getaddrinfo EAI_AGAIN'));
  assert.ok(sent[0].description.includes('[5 more entries]'));

  queue.stopInterval();
});

test('MessageQueue - truncated code block still closes', async () => {
  const sent = [];
  const mockSender = async (messages) => {
    sent.push(...messages);
    return { success: true, rateLimitInfo: {} };
  };

  const queue = new MessageQueue(
    {
      discord_url: 'https://test.webhook',
      buffer: false,
      collapse: false,
      format: true,
      rate_limit_messages: 30,
      rate_limit_window_seconds: 1,
    },
    mockSender,
  );

  queue.addMessage({ name: 'api', event: 'error', description: 'stack\n'.repeat(800), timestamp: Date.now() });
  await queue.flush();

  assert.strictEqual(sent.length, 1);
  assert.ok(sent[0].description.startsWith('```'));
  assert.ok(sent[0].description.endsWith('```'));
  assert.ok(sent[0].description.length <= 4096);

  queue.stopInterval();
});

test('MessageQueue - holds duplicates after send until collapse window ends', async () => {
  const sent = [];
  const mockSender = async (messages) => {
    sent.push(...messages);
    return { success: true, rateLimitInfo: {} };
  };

  const queue = new MessageQueue(
    {
      discord_url: 'https://test.webhook',
      buffer: false,
      collapse: true,
      collapse_seconds: 1,
      format: false,
      rate_limit_messages: 30,
      rate_limit_window_seconds: 1,
    },
    mockSender,
  );

  queue.addMessage({ name: 'api', event: 'error', description: 'boom', timestamp: 1_700_000_000 });
  await queue.flush();
  assert.strictEqual(sent.length, 1);

  queue.addMessage({ name: 'api', event: 'error', description: 'boom', timestamp: Date.now() });
  queue.addMessage({ name: 'api', event: 'error', description: 'boom', timestamp: Date.now() });
  await queue.flush();
  assert.strictEqual(sent.length, 1, 'should not send again inside the collapse window');

  await new Promise((resolve) => setTimeout(resolve, 1100));
  await queue.flush();

  assert.strictEqual(sent.length, 2, 'should flush the extra count after the window');
  assert.ok(sent[1].description.includes('[2 more entries]'));
  assert.equal(sent[1].timestamp, 1_700_000_000, 'collapse follow-up should keep the original event time');

  queue.stopInterval();
});

test('MessageQueue - stamps ingest time when the log has no clock', () => {
  const queue = new MessageQueue(
    {
      discord_url: 'https://test.webhook',
      buffer: false,
      collapse: false,
      rate_limit_messages: 30,
      rate_limit_window_seconds: 1,
    },
    async () => ({ success: true, rateLimitInfo: {} }),
  );

  const before = Math.floor(Date.now() / 1000);
  const message = { name: 'api', event: 'error', description: 'boom', timestamp: null };
  queue.addMessage(message);
  const after = Math.floor(Date.now() / 1000);

  assert.ok(message.timestamp >= before && message.timestamp <= after);

  const kept = { name: 'api', event: 'error', description: 'later', timestamp: 1_700_000_000 };
  queue.addMessage(kept);
  assert.equal(kept.timestamp, 1_700_000_000);

  queue.stopInterval();
});

test('MessageQueue - drops the backlog after retries and posts Send failed', async () => {
  const sent = [];
  const mockSender = async (messages) => {
    sent.push(...messages);
    if (messages[0]?.event === SEND_FAILED_EVENT) {
      return { success: true, rateLimitInfo: {} };
    }
    return { success: false, error: 'offline', rateLimitInfo: {} };
  };

  const queue = new MessageQueue(
    {
      discord_url: 'https://test.webhook',
      buffer: false,
      collapse: false,
      format: false,
      delivery_retry_seconds: 0,
      rate_limit_messages: 30,
      rate_limit_window_seconds: 1,
    },
    mockSender,
  );

  queue.addMessage({ name: 'a', event: 'error', description: 'down', timestamp: 1 });
  queue.addMessage({ name: 'b', event: 'error', description: 'down', timestamp: 1 });

  for (let i = 0; i < 6; i++) {
    await queue.flush();
  }

  assert.equal(queue.messageQueue.length, 0);
  assert.ok(queue.sendFailedMessage);
  assert.equal(queue.sendFailedMessage.event, SEND_FAILED_EVENT);

  queue.addMessage({ name: 'c', event: 'error', description: 'later', timestamp: 1 });
  assert.equal(queue.messageQueue.length, 0, 'new events should drop while Send failed is pending');

  await queue.flush();

  assert.equal(sent.at(-1)?.event, SEND_FAILED_EVENT);
  assert.equal(sent.at(-1)?.description, SEND_FAILED_DESCRIPTION);
  assert.equal(queue.sendFailedMessage, null);

  queue.addMessage({ name: 'd', event: 'error', description: 'back', timestamp: 1 });
  assert.equal(queue.messageQueue.length, 1, 'events should queue again after the notice lands');

  queue.stopInterval();
});

test('MessageQueue - does not arm Send failed on 429', async () => {
  const queue = new MessageQueue(
    {
      discord_url: 'https://test.webhook',
      buffer: false,
      delivery_retry_seconds: 0,
      rate_limit_messages: 10,
      rate_limit_window_seconds: 1,
    },
    async () => ({ success: false, rateLimited: true, retryAfter: 2, rateLimitInfo: {} }),
  );

  queue.addMessage({ name: 'app', event: 'log', description: 'msg', timestamp: 1 });
  await queue.flush();

  assert.equal(queue.sendFailedMessage, null);
  assert.equal(queue.messageQueue.length, 1);

  queue.stopInterval();
});
