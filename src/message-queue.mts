import {
  DISCORD_EMBED_DESCRIPTION_LIMIT,
  fitDiscordPayload,
  messageFingerprint,
  moreEntriesLabel,
} from './log-utils.mjs';
import { debug, log } from './logging.mjs';
import type {
  DiscordMessage,
  DiscordRateLimitInfo,
  MessageQueueConfig,
  RequestHistoryEntry,
  SendToDiscord,
} from './types/index.js';

// Rate limit constants
// Discord webhooks have a specific limit: 30 requests per 60 seconds = 0.5 req/sec
const WEBHOOK_RATE_LIMIT = 30;
const WEBHOOK_RATE_WINDOW_SECONDS = 60;
const DEFAULT_TICK_INTERVAL_MS = 100;

// Max number of retry attempts per message to prevent infinite loops
// and reduce duplicate message risk in edge cases
const MAX_RETRY_ATTEMPTS = 5;
const DEFAULT_DELIVERY_RETRY_SECONDS = 60;

export const SEND_FAILED_EVENT = 'send_failed';
export const SEND_FAILED_DESCRIPTION =
  'Something went wrong when trying to send a message. Please check the logs.';

export class MessageQueue {
  config: MessageQueueConfig;
  messageQueue: DiscordMessage[] = [];
  sender: SendToDiscord;
  requestHistory: RequestHistoryEntry[] = [];
  discordRateLimit: DiscordRateLimitInfo | null = null;
  flushInterval: NodeJS.Timeout | null = null;
  isSending: boolean = false;
  webhookInvalid: boolean = false;

  // Buffer-related properties
  bufferTimer: NodeJS.Timeout | null = null;
  currentBuffer: DiscordMessage[] = [];

  // Backoff timeout for rate limit delays
  backoffTimeout: NodeJS.Timeout | null = null;

  // Throttle settings (calculated from config)
  requestsPerTick: number;
  tickIntervalMs: number;

  // Track if we're in a rate-limited backoff period
  rateLimitedUntil: number = 0;

  characterCount: number = 0;

  // Shutdown state to prevent new operations during graceful shutdown
  isShuttingDown: boolean = false;

  recentSent: Map<string, { at: number; template: DiscordMessage }> = new Map();
  pendingMore: Map<string, { extra: number; template: DiscordMessage; timer: NodeJS.Timeout }> =
    new Map();

  sendFailedMessage: DiscordMessage | null = null;
  deliveryRetryAt: number = 0;
  deliveryRetryMs: number;

  constructor(config: MessageQueueConfig, sender: SendToDiscord) {
    this.config = config;
    this.sender = sender;

    // Calculate throttle settings from user config
    // User specifies: rate_limit_messages per rate_limit_window_seconds
    // We need to convert this to: how many requests to send per tick interval

    // Step 1: Extract user's rate limit settings (or use Discord webhook defaults)
    // Discord webhooks: max 30 requests per 60 seconds
    const messages = config.rate_limit_messages ?? WEBHOOK_RATE_LIMIT;
    const windowSeconds = config.rate_limit_window_seconds ?? WEBHOOK_RATE_WINDOW_SECONDS;

    // Step 2: Convert to requests per second
    // Example: 30 messages / 60 seconds = 0.5 requests/second
    const userRatePerSecond = messages / windowSeconds;

    // Step 3: Enforce Discord's hard limit (never exceed 0.5 req/sec)
    // This ensures we respect Discord's rate limits even if user config is too aggressive
    const webhookMaxRatePerSecond = WEBHOOK_RATE_LIMIT / WEBHOOK_RATE_WINDOW_SECONDS;
    const safeRatePerSecond = Math.min(userRatePerSecond, webhookMaxRatePerSecond);

    // Step 4: Calculate tick interval and requests per tick
    // Two cases:
    // Case A: Very low rates (< 1/sec) - use longer intervals
    //   Example: 0.5/sec = 1 request every 2 seconds = 2000ms between ticks
    // Case B: Higher rates (>= 1/sec) - use standard 100ms tick and send multiple per tick
    //   Example: 2/sec with 100ms tick = send 0.2 requests per tick (rounded to 0)
    if (safeRatePerSecond < 1) {
      // Low rate: send 1 request per extended interval
      this.requestsPerTick = 1;
      this.tickIntervalMs = Math.floor(1000 / safeRatePerSecond);
    } else {
      // Higher rate: use standard interval and calculate requests per tick
      // Formula: (requests/sec) * (tick_duration_sec) = requests/tick
      // Example: 2 req/sec * 0.1 sec = 0.2 requests/tick (min 1)
      this.tickIntervalMs = DEFAULT_TICK_INTERVAL_MS;
      this.requestsPerTick = Math.max(
        1,
        Math.floor(safeRatePerSecond * (this.tickIntervalMs / 1000)),
      );
    }

    this.deliveryRetryMs = Math.max(
      0,
      (config.delivery_retry_seconds ?? DEFAULT_DELIVERY_RETRY_SECONDS) * 1000,
    );
  }

  /**
   * Get the effective rate in requests per second.
   * Useful for testing and debugging rate limit calculations.
   *
   * @returns Effective rate limit in requests per second
   * @example
   * // With default config (30 messages per 60 seconds):
   * queue.getEffectiveRate() // => 0.5 (30/60)
   */
  getEffectiveRate(): number {
    return this.requestsPerTick * (1000 / this.tickIntervalMs);
  }

  /**
   * Get the time window for rate limiting in milliseconds.
   * Useful for testing and debugging rate limit window calculations.
   *
   * @returns Rate limit window duration in milliseconds
   * @example
   * // With default 60 second window:
   * queue.getEffectiveWindow() // => 60000
   */
  getEffectiveWindow(): number {
    const windowSeconds = this.config.rate_limit_window_seconds ?? WEBHOOK_RATE_WINDOW_SECONDS;
    return windowSeconds * 1000;
  }

  /**
   * Checks if webhook has been marked as invalid (404 response).
   * When a webhook returns 404, it's marked invalid to prevent repeated failed requests.
   *
   * @returns true if webhook is invalid and should not be used, false otherwise
   */
  isWebhookInvalid(): boolean {
    return this.webhookInvalid;
  }

  /**
   * Records a request in the history for rate limit tracking.
   * Used for testing and monitoring request patterns.
   *
   * @param timestamp - Optional timestamp in milliseconds. Defaults to Date.now()
   */
  recordRequest(timestamp?: number): void {
    this.requestHistory.push({
      timestamp: timestamp || Date.now(),
      messageCount: 1,
    });
  }

  /**
   * Removes old request history entries outside the current rate limit window.
   * Prevents unbounded memory growth by cleaning up stale tracking data.
   * Called automatically during processTick to maintain a bounded history array.
   */
  cleanupRequestHistory(): void {
    const now = Date.now();
    const window = this.getEffectiveWindow();
    this.requestHistory = this.requestHistory.filter((entry) => {
      return now - entry.timestamp < window;
    });
  }

  /**
   * Returns the complete request history for monitoring and testing.
   * History includes timestamps of all requests within the rate limit window.
   *
   * @returns Array of request history entries with timestamps
   */
  getRequestHistory(): RequestHistoryEntry[] {
    return this.requestHistory;
  }

  /**
   * Checks if a request can be sent immediately (not in rate limit backoff).
   * Returns false when Discord has rate limited us and we're waiting for retry_after to expire.
   *
   * @returns true if we can send now, false if we're in backoff period
   */
  canSendNow(): boolean {
    return Date.now() >= this.rateLimitedUntil;
  }

  /**
   * Calculates delay in milliseconds until next send is allowed.
   * Returns 0 if we can send immediately, otherwise returns remaining backoff time.
   *
   * @returns Milliseconds to wait before next send attempt (0 if ready now)
   * @example
   * // If rate limited for 2 more seconds:
   * queue.getDelayUntilNextSend() // => 2000
   *
   * // If ready to send:
   * queue.getDelayUntilNextSend() // => 0
   */
  getDelayUntilNextSend(): number {
    const now = Date.now();
    if (now >= this.rateLimitedUntil) {
      return 0;
    }
    return this.rateLimitedUntil - now;
  }

  collapseEnabled(): boolean {
    return this.config.collapse ?? true;
  }

  collapseWindowMs(): number {
    return (this.config.collapse_seconds ?? 60) * 1000;
  }

  formatEnabled(): boolean {
    return this.config.format ?? true;
  }

  bodyLimit(): number {
    // Leave room for ``` fences and a "[N more entries]" suffix outside the fence.
    return DISCORD_EMBED_DESCRIPTION_LIMIT - (this.formatEnabled() ? 6 : 0) - 24;
  }

  fingerprintOf(message: DiscordMessage): string {
    return (
      message._fingerprint ?? messageFingerprint(message.name, message.event, message.description)
    );
  }

  findUnsent(fingerprint: string): DiscordMessage | undefined {
    return (
      this.currentBuffer.find((msg) => msg._fingerprint === fingerprint) ??
      this.messageQueue.find((msg) => msg._fingerprint === fingerprint)
    );
  }

  descriptionWithCount(message: DiscordMessage): string {
    const extra = (message._repeatCount ?? 1) - 1;
    const body = message.description ?? '';
    if (extra < 1) {
      return body;
    }
    return `${body}\n${moreEntriesLabel(extra)}`;
  }

  prepareForSend(message: DiscordMessage): DiscordMessage {
    const asCodeBlock = this.formatEnabled() && message.event !== SEND_FAILED_EVENT;
    return {
      ...message,
      description: fitDiscordPayload(
        message.description ?? '',
        message._repeatCount ?? 1,
        asCodeBlock,
      ),
    };
  }

  recordSent(messages: DiscordMessage[]): void {
    const now = Date.now();
    for (const message of messages) {
      const fingerprint = this.fingerprintOf(message);
      this.recentSent.set(fingerprint, {
        at: now,
        template: {
          name: message.name,
          event: message.event,
          description: message.description,
          timestamp: message.timestamp,
        },
      });
    }
  }

  flushPendingMore(fingerprint: string): void {
    const pending = this.pendingMore.get(fingerprint);
    if (!pending) {
      return;
    }
    this.pendingMore.delete(fingerprint);
    clearTimeout(pending.timer);
    if (pending.extra < 1) {
      return;
    }
    this.messageQueue.push({
      name: pending.template.name,
      event: pending.template.event,
      description: pending.template.description,
      timestamp: pending.template.timestamp ?? Math.floor(Date.now() / 1000),
      _repeatCount: pending.extra + 1,
      _fingerprint: fingerprint,
    });
    if (!this.isShuttingDown) {
      this.startInterval();
    }
  }

  tryCollapse(message: DiscordMessage): boolean {
    if (!this.collapseEnabled()) {
      return false;
    }

    const fingerprint = this.fingerprintOf(message);
    message._fingerprint = fingerprint;
    const now = Date.now();
    const windowMs = this.collapseWindowMs();

    const unsent = this.findUnsent(fingerprint);
    if (unsent) {
      unsent._repeatCount = (unsent._repeatCount ?? 1) + 1;
      return true;
    }

    const recent = this.recentSent.get(fingerprint);
    if (recent && now - recent.at < windowMs) {
      const existing = this.pendingMore.get(fingerprint);
      if (existing) {
        existing.extra += 1;
        return true;
      }
      const remaining = Math.max(0, windowMs - (now - recent.at));
      const pending = {
        extra: 1,
        template: recent.template,
        timer: setTimeout(() => {
          this.flushPendingMore(fingerprint);
        }, remaining),
      };
      this.pendingMore.set(fingerprint, pending);
      return true;
    }

    message._repeatCount = 1;
    return false;
  }

  dropQueuedWork(): void {
    this.messageQueue = [];
    this.currentBuffer = [];
    this.characterCount = 0;
    if (this.bufferTimer) {
      clearTimeout(this.bufferTimer);
      this.bufferTimer = null;
    }
    for (const pending of this.pendingMore.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingMore.clear();
  }

  armSendFailedNotice(): void {
    this.dropQueuedWork();
    if (!this.sendFailedMessage) {
      this.sendFailedMessage = {
        name: 'PM2',
        event: SEND_FAILED_EVENT,
        description: SEND_FAILED_DESCRIPTION,
        timestamp: Math.floor(Date.now() / 1000),
      };
      log(
        'warn',
        'Discord delivery failed. Dropping queued events and retrying a Send failed notice.',
      );
    }
    this.deliveryRetryAt = Date.now() + this.deliveryRetryMs;
    if (!this.isShuttingDown) {
      this.startInterval();
    }
  }

  async processSendFailedNotice(): Promise<void> {
    if (!this.sendFailedMessage || Date.now() < this.deliveryRetryAt) {
      return;
    }

    this.isSending = true;
    try {
      this.recordRequest();
      this.cleanupRequestHistory();
      const prepared = this.prepareForSend(this.sendFailedMessage);
      const result = await this.sender([prepared], this.config.discord_url);

      if (result.rateLimitInfo) {
        this.discordRateLimit = result.rateLimitInfo;
      }

      if (result.webhookInvalid) {
        log('error', 'Webhook marked as invalid. Stopping message processing.');
        this.webhookInvalid = true;
        this.sendFailedMessage = null;
        this.stopInterval();
        return;
      }

      if (result.rateLimited && result.retryAfter) {
        this.rateLimitedUntil = Date.now() + result.retryAfter * 1000;
        this.deliveryRetryAt = this.rateLimitedUntil;
        return;
      }

      if (result.success) {
        this.sendFailedMessage = null;
        this.deliveryRetryAt = 0;
        this.stopInterval();
        return;
      }

      this.deliveryRetryAt = Date.now() + this.deliveryRetryMs;
    } catch (error) {
      log('error', 'Error sending Send failed notice:', error);
      this.deliveryRetryAt = Date.now() + this.deliveryRetryMs;
    } finally {
      this.isSending = false;
    }
  }

  /**
   * Process one tick of the queue - send up to requestsPerTick messages
   */
  async processTick(): Promise<void> {
    // Don't process if already sending, webhook is invalid, or we're shutting down
    if (this.isSending || this.webhookInvalid || this.isShuttingDown) {
      return;
    }

    if (this.sendFailedMessage) {
      if (!this.canSendNow()) {
        this.deliveryRetryAt = Math.max(this.deliveryRetryAt, this.rateLimitedUntil);
      }
      await this.processSendFailedNotice();
      return;
    }

    // If in backoff, schedule a check for when it expires (unless shutting down)
    if (!this.canSendNow()) {
      if (this.flushInterval) {
        this.stopInterval();
      }
      if (!this.isShuttingDown) {
        const delay = this.getDelayUntilNextSend();
        log('log', `In rate limit backoff, delaying next send by ${delay}ms`);
        this.backoffTimeout = setTimeout(() => {
          this.backoffTimeout = null;
          this.startInterval();
        }, delay);
      }
      return;
    }

    // If queue is empty, stop the interval
    if (this.messageQueue.length === 0) {
      this.stopInterval();
      return;
    }

    this.isSending = true;

    try {
      // Take up to requestsPerTick messages from the queue
      const messagesToSend = this.messageQueue.splice(0, this.requestsPerTick);

      if (messagesToSend.length === 0) {
        return;
      }

      // Record the request
      this.recordRequest();

      // Clean up old request history to prevent memory leak
      this.cleanupRequestHistory();

      // Send to Discord
      const prepared = messagesToSend.map((msg) => this.prepareForSend(msg));
      const result = await this.sender(prepared, this.config.discord_url);

      // Update Discord rate limit info if provided
      if (result.rateLimitInfo) {
        this.discordRateLimit = result.rateLimitInfo;
      }

      // Handle webhook invalid (404) - stop sending
      if (result.webhookInvalid) {
        log('error', 'Webhook marked as invalid. Stopping message processing.');
        this.webhookInvalid = true;
        this.stopInterval();
        // Don't put messages back - they can't be sent to an invalid webhook
        return;
      }

      // Handle rate limit response - enter backoff period
      if (result.rateLimited && result.retryAfter) {
        log('log', `Rate limited by Discord. Backing off for ${result.retryAfter}s`);
        this.rateLimitedUntil = Date.now() + result.retryAfter * 1000;
        // Put messages back at front of queue for retry (if not exceeding max attempts)
        // Track retry attempts to prevent infinite loops in edge cases
        messagesToSend.forEach((msg) => {
          msg._retryAttempts = (msg._retryAttempts ?? 0) + 1;
          if (msg._retryAttempts <= MAX_RETRY_ATTEMPTS) {
            this.messageQueue.unshift(msg);
          } else {
            log('warn', `Message exceeded max retry attempts (${MAX_RETRY_ATTEMPTS}), discarding`);
          }
        });
      } else if (result.success) {
        this.recordSent(messagesToSend);
      } else if (!result.success) {
        let deliveryFailed = false;
        messagesToSend.forEach((msg) => {
          msg._retryAttempts = (msg._retryAttempts ?? 0) + 1;
          if (msg._retryAttempts <= MAX_RETRY_ATTEMPTS) {
            this.messageQueue.unshift(msg);
          } else {
            log(
              'warn',
              `Message exceeded max retry attempts (${MAX_RETRY_ATTEMPTS}), discarding: ${result.error}`,
            );
            deliveryFailed = true;
          }
        });
        if (deliveryFailed) {
          this.armSendFailedNotice();
        }
      }
    } catch (error) {
      log('error', 'Error sending to Discord:', error);
    } finally {
      this.isSending = false;
    }
  }

  /**
   * Start the throttling interval
   * Will not start if shutdown is in progress
   */
  startInterval(): void {
    if (this.flushInterval || this.isShuttingDown) {
      return; // Already running or shutting down
    }

    this.flushInterval = setInterval(() => {
      this.processTick().catch((err) => {
        log('error', 'Error in processTick:', err);
      });
    }, this.tickIntervalMs);
  }

  /**
   * Stops all timers and intervals for this queue.
   * Clears both the processing interval and buffer flush timer.
   * Called during shutdown or when queue is empty.
   */
  stopInterval(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    if (this.bufferTimer) {
      clearTimeout(this.bufferTimer);
      this.bufferTimer = null;
    }
    if (this.backoffTimeout) {
      clearTimeout(this.backoffTimeout);
      this.backoffTimeout = null;
    }
  }

  /**
   * Initiates graceful shutdown of this message queue.
   * Sets shutdown flag to prevent new operations and stops all timers.
   * Should be called before flushing remaining messages during process exit.
   */
  beginShutdown(): void {
    this.isShuttingDown = true;
    for (const fingerprint of this.pendingMore.keys()) {
      this.flushPendingMore(fingerprint);
    }
    this.stopInterval();
  }

  /**
   * Flushes the current message buffer by combining all buffered messages into one.
   * Messages are joined with newlines and added to the processing queue.
   * Resets the buffer and character count to start fresh.
   * Called either when buffer timer expires or when buffer reaches size/character limits.
   */
  flushBuffer(): void {
    this.characterCount = 0;

    if (this.currentBuffer.length === 0) {
      return;
    }

    // Combine all buffered messages into one. A single unique message keeps its
    // object identity so later duplicates can still increment _repeatCount.
    if (this.currentBuffer.length === 1) {
      this.messageQueue.push(this.currentBuffer[0]);
    } else {
      const combinedMessage: DiscordMessage = {
        name: this.currentBuffer[0].name,
        event: this.currentBuffer[0].event,
        description: this.currentBuffer.map((m) => this.descriptionWithCount(m)).join('\n'),
        timestamp: this.currentBuffer[0].timestamp,
      };
      this.messageQueue.push(combinedMessage);
    }

    // Clear the buffer
    this.currentBuffer = [];

    // Start the interval if not already running
    if (!this.flushInterval) {
      this.startInterval();
    }
  }

  /**
   * Checks if the buffer should be flushed immediately.
   * Flushes when character count reaches Discord's embed description limit or queue_max messages.
   *
   * @returns true if buffer should flush now, false otherwise
   */
  shouldFlushBuffer(): boolean {
    return (
      this.characterCount >= this.bodyLimit() ||
      this.currentBuffer.length >= (this.config.queue_max ?? 100)
    );
  }

  /**
   * Adds a message to the queue for sending to Discord.
   * If buffering is enabled, messages are combined within buffer_seconds window.
   * If buffering is disabled, messages are added directly to the processing queue.
   * Automatically handles character limits and truncates oversized messages.
   *
   * During shutdown, new messages are rejected with a warning.
   *
   * @param message - Discord message to add (will be mutated if truncation needed)
   */
  addMessage(message: DiscordMessage): void {
    if (this.isShuttingDown) {
      log('warn', 'Ignoring message received during shutdown');
      return;
    }

    if (this.sendFailedMessage) {
      debug('Dropping event; waiting to report a previous send failure');
      return;
    }

    const bufferEnabled = this.config.buffer ?? true;
    const bufferSeconds = this.config.buffer_seconds ?? 1;

    debug('Buffer is set to:', bufferEnabled, 'Buffer seconds:', bufferSeconds);

    if (
      typeof message.timestamp !== 'number' ||
      !Number.isFinite(message.timestamp) ||
      message.timestamp <= 0
    ) {
      // PM2 does not queue. Stamp when we hear the event so Discord still
      // shows that time after a later buffer, collapse, or webhook retry.
      message.timestamp = Math.floor(Date.now() / 1000);
    }

    if (this.tryCollapse(message)) {
      return;
    }

    let newMessageLength = message.description?.length ?? 0;
    const bodyLimit = this.bodyLimit();

    if (newMessageLength > bodyLimit) {
      log('warn', 'Single message exceeds Discord character limit, truncating...');
      message.description =
        (message.description ?? '').slice(0, Math.max(0, bodyLimit - 3)) + '...';
      newMessageLength = message.description.length;
    }

    if (bufferEnabled) {
      // if adding this new message would exceed Discord's embed description limit, flush current buffer first
      // When joining messages with '\n', we add (buffer.length) newline characters total
      // For current buffer of size N, adding 1 message means (N) newlines between all messages
      const newlinesThatWillExist = this.currentBuffer.length; // Each message except first has a newline before it

      if (this.characterCount + newlinesThatWillExist + newMessageLength > this.bodyLimit()) {
        log(
          'log',
          'Adding this message would exceed the embed description limit, flushing current buffer first.',
        );
        this.flushBuffer();
      }

      // Add to current buffer
      this.currentBuffer.push(message);
      // Track message length (newlines are accounted for during character count check)
      this.characterCount += newMessageLength;
      // Check if buffer has reached queue_max - if so, flush immediately
      if (this.shouldFlushBuffer()) {
        log('log', 'Buffer reached queue_max, flushing immediately.');
        // Cancel the timer since we're flushing now
        if (this.bufferTimer) {
          clearTimeout(this.bufferTimer);
          this.bufferTimer = null;
        }
        this.flushBuffer();
        return;
      }

      // Reset the buffer timer
      if (this.bufferTimer) {
        clearTimeout(this.bufferTimer);
      }

      // Set timer to flush buffer after buffer_seconds (unless shutting down)
      if (!this.isShuttingDown) {
        this.bufferTimer = setTimeout(() => {
          this.flushBuffer();
        }, bufferSeconds * 1000);
      }
    } else {
      // No buffering - add directly to queue
      this.messageQueue.push(message);

      // Start the interval if not already running
      if (!this.flushInterval) {
        this.startInterval();
      }
    }
  }

  /**
   * Triggers immediate processing of queued messages (for testing).
   * Calls processTick once to send up to requestsPerTick messages.
   * Used primarily in unit tests to synchronously process the queue.
   *
   * @returns Promise that resolves when the tick completes
   */
  async flush(): Promise<void> {
    await this.processTick();
  }
}
