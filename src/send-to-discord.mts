import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DISCORD_EMBED_TITLE_LIMIT, DISCORD_MAX_EMBEDS } from './log-utils.mjs';
import { debug, log } from './logging.mjs';
import type {
  DiscordEmbed,
  DiscordMessage,
  DiscordRateLimitInfo,
  SendToDiscordResult,
} from './types/index.js';

// Get version from package.json
const __dirname = join(fileURLToPath(import.meta.url), '..');
let VERSION = 'unknown version'; // fallback
try {
  const packageJson = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
  VERSION = packageJson.version || VERSION;
  debug(`pm2-discord version: ${VERSION}`);
} catch (e) {
  // If we can't read package.json, use fallback version
  log('error', 'Could not read version from package.json:', e);
}

/**
 * Parse rate limit headers from Discord API response
 */
function parseRateLimitHeaders(headers: Headers): DiscordRateLimitInfo {
  const limit = headers.get('x-ratelimit-limit');
  const remaining = headers.get('x-ratelimit-remaining');
  const reset = headers.get('x-ratelimit-reset');
  const resetAfter = headers.get('x-ratelimit-reset-after');
  return {
    limit: limit ? parseInt(limit, 10) : undefined,
    remaining: remaining ? parseInt(remaining, 10) : undefined,
    reset: reset ? parseInt(reset, 10) : undefined,
    resetAfter: resetAfter ? parseFloat(resetAfter) : undefined,
    bucket: headers.get('x-ratelimit-bucket') || undefined,
  };
}

async function discordErrorDetail(res: Response): Promise<string> {
  try {
    const text = (await res.text()).trim();
    if (!text) {
      return res.statusText;
    }
    return text.length > 500 ? `${text.slice(0, 500)}...` : text;
  } catch {
    return res.statusText;
  }
}

function readRetryAfter(body: unknown): { retryAfter: number; isGlobal: boolean } {
  if (typeof body !== 'object' || body === null) {
    return { retryAfter: 0, isGlobal: false };
  }
  const retryAfter =
    'retry_after' in body && typeof body.retry_after === 'number' ? body.retry_after : 0;
  const isGlobal = 'global' in body && Boolean(body.global);
  return { retryAfter, isGlobal };
}

/** Discord rejects webhook usernames outside 1-80 chars, or that contain these words. */
const DISCORD_USERNAME_LIMIT = 80;

function discordSafeName(name: string): string {
  return name
    .replace(/discord|clyde/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-_,]+|[\s\-_,]+$/g, '')
    .trim();
}

/**
 * Webhook username from process names. Discord returns 400 if the name contains
 * "discord" or "clyde", so those words are removed before the name is sent.
 */
export function getUserName(messages: DiscordMessage[]): string {
  const names = new Set(
    messages.map((msg) => discordSafeName(msg.name)).filter((name) => name.length > 0),
  );
  const joined = Array.from(names)
    .join(', ')
    .replace(/[\s,]+$/, '');
  if (!joined) {
    return 'PM2';
  }
  return joined.length > DISCORD_USERNAME_LIMIT
    ? joined.slice(0, DISCORD_USERNAME_LIMIT).replace(/[\s,]+$/, '')
    : joined;
}

export const EVENT_EMBED_STYLES: Record<string, { title: string; color: number }> = {
  log: { title: 'Log', color: 0x0366d6 },
  error: { title: 'Error', color: 0xcb2431 },
  exception: { title: 'Exception', color: 0xcb2431 },
  kill: { title: 'Kill', color: 0x6c757d },
  restart: { title: 'Restart', color: 0xdbab09 },
  'restart overlimit': { title: 'Restart overlimit', color: 0xcb2431 },
  send_failed: { title: 'Send failed', color: 0xdbab09 },
  stop: { title: 'Stop', color: 0x95999c },
  delete: { title: 'Delete', color: 0x95999c },
  exit: { title: 'Exit', color: 0x95999c },
  start: { title: 'Start', color: 0x28a745 },
  online: { title: 'Online', color: 0x28a745 },
};

export function eventEmbedStyle(event: string): { title: string; color: number } {
  const known = EVENT_EMBED_STYLES[event];
  if (known) {
    return known;
  }
  const title = event.length > 0 ? event.charAt(0).toUpperCase() + event.slice(1) : 'Event';
  return { title: title.slice(0, DISCORD_EMBED_TITLE_LIMIT), color: 0x6c757d };
}

export function embedTimestamp(
  unixSeconds: number | null | undefined,
  sentAtMs = Date.now(),
): string {
  if (typeof unixSeconds === 'number' && Number.isFinite(unixSeconds) && unixSeconds > 0) {
    return new Date(unixSeconds * 1000).toISOString();
  }
  return new Date(sentAtMs).toISOString();
}

export function buildWebhookPayload(
  messages: DiscordMessage[],
  sentAtMs = Date.now(),
): { username: string; embeds: DiscordEmbed[] } {
  return {
    username: getUserName(messages),
    embeds: messages.slice(0, DISCORD_MAX_EMBEDS).map((msg) => {
      const { title, color } = eventEmbedStyle(msg.event);
      const embed: DiscordEmbed = {
        title,
        color,
        timestamp: embedTimestamp(msg.timestamp, sentAtMs),
      };
      if (msg.description) {
        embed.description = msg.description;
      }
      return embed;
    }),
  };
}

/**
 * Send messages to Discord's Incoming Webhook with rate limit handling
 */
export async function sendToDiscord(
  messages: DiscordMessage[],
  discord_url: string | null,
): Promise<SendToDiscordResult> {
  if (!messages || messages.length === 0) {
    return {
      success: true,
      rateLimitInfo: {},
    };
  }

  // If a Discord URL is not set, we do not want to continue and notify the user that it needs to be set
  if (!discord_url) {
    log('error', 'Discord URL is not configured.');
    return {
      success: false,
      error: 'Discord URL not configured',
      rateLimitInfo: {},
    };
  }

  const payload = buildWebhookPayload(messages);

  // Options for the post request
  const options = {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': `pm2-discord@${VERSION}`,
    },
  };

  // Set up timeout protection (Discord should respond quickly)
  const FETCH_TIMEOUT_MS = 5000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    debug('Sending to Discord');
    const res = await fetch(discord_url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);
    debug(`Discord webhook responded with status ${res.status}`);

    // Parse rate limit headers from response
    const rateLimitInfo = parseRateLimitHeaders(res.headers);

    // Handle 429 Too Many Requests
    if (res.status === 429) {
      let retryAfter: number;
      let isGlobal = false;

      try {
        const parsed = readRetryAfter(await res.json());
        retryAfter = parsed.retryAfter;
        isGlobal = parsed.isGlobal;
      } catch {
        const header = res.headers.get('retry-after');
        retryAfter = header ? parseFloat(header) : 0;
      }

      if (res.headers.get('x-ratelimit-global')) {
        isGlobal = true;
      }

      log(
        'error',
        `Discord rate limit hit. ${isGlobal ? 'Global' : 'Route'} limit. Retry after ${retryAfter}s`,
      );

      return {
        success: false,
        rateLimited: true,
        retryAfter,
        isGlobal,
        rateLimitInfo,
      };
    }

    // A successful POST to Discord's webhook responds with a 204 NO CONTENT
    if (res.status === 204) {
      return {
        success: true,
        rateLimitInfo,
      };
    }

    // Handle 404 - webhook no longer exists, stop trying to use it
    if (res.status === 404) {
      log(
        'error',
        `Discord webhook returned 404 Not Found. Webhook is invalid and will not be retried.`,
      );
      return {
        success: false,
        webhookInvalid: true,
        error: `HTTP ${res.status}: ${res.statusText}`,
        rateLimitInfo,
      };
    }

    // Handle other error statuses. Include Discord's body: statusText is only "Bad Request".
    const detail = await discordErrorDetail(res);
    log(
      'error',
      `Discord webhook returned status ${res.status} for username "${payload.username}": ${detail}`,
    );
    return {
      success: false,
      error: `HTTP ${res.status}: ${detail}`,
      rateLimitInfo,
    };
  } catch (error: unknown) {
    clearTimeout(timeoutId);

    if (error instanceof Error && error.name === 'AbortError') {
      log('error', `Discord webhook request timed out after ${FETCH_TIMEOUT_MS}ms`);
      return {
        success: false,
        error: 'Webhook request timeout',
        rateLimited: false,
        rateLimitInfo: {},
      };
    }

    const message = error instanceof Error ? error.message : String(error);
    log('error', `Error sending to Discord: ${message}`);
    return {
      success: false,
      error: message,
      rateLimited: false,
      rateLimitInfo: {},
    };
  }
}
