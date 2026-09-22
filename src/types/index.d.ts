export interface DiscordEmbed {
  title: string;
  description?: string;
  color: number;
  timestamp: string;
}

export interface DiscordMessage {
  name: string;
  event: string;
  description: string | null;
  timestamp: number | null;
  /**
   * Internal: Number of times this message has been attempted to send.
   * Used to prevent infinite retries in case of persistent failures.
   */
  _retryAttempts?: number;
  /**
   * Internal: how many times this message (including the first) has been seen
   * inside the collapse window.
   */
  _repeatCount?: number;
  /**
   * Internal: collapse key for duplicate matching.
   */
  _fingerprint?: string;
}

export interface Process {
  name: string;
  exec_mode: string;
  instances: number;
  pm_id: string | number;
}

// data.process.name
export interface BusData {
  process: Process;
  data?: unknown;
  event?: string;
  msg?: string;
}

export interface Pm2Bus {
  on(event: string, handler: (data: BusData) => unknown): void;
}

export interface LogMessage {
  description: string | null;
  timestamp: number | null;
}

/**
 * Discord API rate limit information from response headers
 */
export interface DiscordRateLimitInfo {
  /** The number of requests that can be made */
  limit?: number;
  /** The number of remaining requests that can be made */
  remaining?: number;
  /** Epoch time (seconds) at which the rate limit resets */
  reset?: number;
  /** Total time (in seconds) of when the current rate limit bucket will reset */
  resetAfter?: number;
  /** A unique string denoting the rate limit being encountered */
  bucket?: string;
}

/**
 * Result from sending messages to Discord
 */
export interface SendToDiscordResult {
  /** Whether the request was successful */
  success: boolean;
  /** Whether the request was rate limited (429 response) */
  rateLimited?: boolean;
  /** Seconds to wait before retrying (from Retry-After header or response body) */
  retryAfter?: number;
  /** Whether this is a global rate limit */
  isGlobal?: boolean;
  /** Whether the webhook is invalid (404 response) - should stop sending */
  webhookInvalid?: boolean;
  /** Rate limit information from response headers */
  rateLimitInfo: DiscordRateLimitInfo;
  /** Error message if request failed */
  error?: string;
}

export interface SendToDiscord {
  (messages: DiscordMessage[], discord_url: string | null): Promise<SendToDiscordResult>;
}

/**
 * Tracks a single request in the rate limit history
 */
export interface RequestHistoryEntry {
  timestamp: number;
  messageCount: number;
}

/**
 * These config items customize the message queue behavior
 */
export interface MessageQueueConfig {
  discord_url: string | null;
  rate_limit_messages: number;
  rate_limit_window_seconds: number;
  buffer: boolean;
  buffer_seconds: number;
  queue_max: number;
  collapse?: boolean;
  collapse_seconds?: number;
  format?: boolean;
  /** Seconds between Send failed notice retries. Not a pm2 set key. Default 60. */
  delivery_retry_seconds?: number;
}

/**
 * These config items control which PM2 `process:events` are forwarded
 */
interface Pm2ProcessEvents {
  restart: boolean;
  delete: boolean;
  stop: boolean;
  'restart overlimit': boolean;
  exit: boolean;
  start: boolean;
  online: boolean;
}

export interface Config extends MessageQueueConfig, Pm2ProcessEvents {
  /**
   * Filter by process name (only forward events from this process). Null to disable.
   */
  process_name: string | null;

  /**
   * Enable message triple backtick message formatting (code blocks)
   */
  format: boolean;

  /**
   * Collapse duplicate / similar messages inside collapse_seconds into one payload
   */
  collapse: boolean;

  /**
   * Window in seconds for collapsing similar messages
   */
  collapse_seconds: number;

  /**
   * Enable `log:out` event forwarding
   */
  log: boolean;

  /**
   * Enable `log:err` event forwarding
   */
  error: boolean;

  /**
   * Enable `'pm2:kill'` event forwarding
   */
  kill: boolean;

  /**
   * Enable `process:exception` event forwarding
   */
  exception: boolean;

  /**
   * Optional Sentinel ingest URL (process metrics only; no HTTP surface here).
   */
  sentinel_ingest_url: string | null;

  /**
   * Optional Sentinel ingest bearer token.
   */
  sentinel_ingest_token: string | null;
}
