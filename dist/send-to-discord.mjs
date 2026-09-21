import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DISCORD_EMBED_TITLE_LIMIT, DISCORD_MAX_EMBEDS } from './log-utils.mjs';
import { debug, log } from './logging.mjs';
const __dirname = join(fileURLToPath(import.meta.url), '..');
let VERSION = 'unknown version';
try {
    const packageJson = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
    VERSION = packageJson.version || VERSION;
    debug(`pm2-discord version: ${VERSION}`);
}
catch (e) {
    log('error', 'Could not read version from package.json:', e);
}
function parseRateLimitHeaders(headers) {
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
async function discordErrorDetail(res) {
    try {
        const text = (await res.text()).trim();
        if (!text) {
            return res.statusText;
        }
        return text.length > 500 ? `${text.slice(0, 500)}...` : text;
    }
    catch {
        return res.statusText;
    }
}
function readRetryAfter(body) {
    if (typeof body !== 'object' || body === null) {
        return { retryAfter: 0, isGlobal: false };
    }
    const retryAfter = 'retry_after' in body && typeof body.retry_after === 'number' ? body.retry_after : 0;
    const isGlobal = 'global' in body && Boolean(body.global);
    return { retryAfter, isGlobal };
}
const DISCORD_USERNAME_LIMIT = 80;
function discordSafeName(name) {
    return name
        .replace(/discord|clyde/gi, '')
        .replace(/\s+/g, ' ')
        .replace(/^[\s\-_,]+|[\s\-_,]+$/g, '')
        .trim();
}
export function getUserName(messages) {
    const names = new Set(messages.map((msg) => discordSafeName(msg.name)).filter((name) => name.length > 0));
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
export const EVENT_EMBED_STYLES = {
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
export function eventEmbedStyle(event) {
    const known = EVENT_EMBED_STYLES[event];
    if (known) {
        return known;
    }
    const title = event.length > 0 ? event.charAt(0).toUpperCase() + event.slice(1) : 'Event';
    return { title: title.slice(0, DISCORD_EMBED_TITLE_LIMIT), color: 0x6c757d };
}
export function embedTimestamp(unixSeconds, sentAtMs = Date.now()) {
    if (typeof unixSeconds === 'number' && Number.isFinite(unixSeconds) && unixSeconds > 0) {
        return new Date(unixSeconds * 1000).toISOString();
    }
    return new Date(sentAtMs).toISOString();
}
export function buildWebhookPayload(messages, sentAtMs = Date.now()) {
    return {
        username: getUserName(messages),
        embeds: messages.slice(0, DISCORD_MAX_EMBEDS).map((msg) => {
            const { title, color } = eventEmbedStyle(msg.event);
            const embed = {
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
export async function sendToDiscord(messages, discord_url) {
    if (!messages || messages.length === 0) {
        return {
            success: true,
            rateLimitInfo: {},
        };
    }
    if (!discord_url) {
        log('error', 'Discord URL is not configured.');
        return {
            success: false,
            error: 'Discord URL not configured',
            rateLimitInfo: {},
        };
    }
    const payload = buildWebhookPayload(messages);
    const options = {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': `pm2-discord@${VERSION}`,
        },
    };
    const FETCH_TIMEOUT_MS = 5000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        debug('Sending to Discord');
        const res = await fetch(discord_url, { ...options, signal: controller.signal });
        clearTimeout(timeoutId);
        debug(`Discord webhook responded with status ${res.status}`);
        const rateLimitInfo = parseRateLimitHeaders(res.headers);
        if (res.status === 429) {
            let retryAfter;
            let isGlobal = false;
            try {
                const parsed = readRetryAfter(await res.json());
                retryAfter = parsed.retryAfter;
                isGlobal = parsed.isGlobal;
            }
            catch {
                const header = res.headers.get('retry-after');
                retryAfter = header ? parseFloat(header) : 0;
            }
            if (res.headers.get('x-ratelimit-global')) {
                isGlobal = true;
            }
            log('error', `Discord rate limit hit. ${isGlobal ? 'Global' : 'Route'} limit. Retry after ${retryAfter}s`);
            return {
                success: false,
                rateLimited: true,
                retryAfter,
                isGlobal,
                rateLimitInfo,
            };
        }
        if (res.status === 204) {
            return {
                success: true,
                rateLimitInfo,
            };
        }
        if (res.status === 404) {
            log('error', `Discord webhook returned 404 Not Found. Webhook is invalid and will not be retried.`);
            return {
                success: false,
                webhookInvalid: true,
                error: `HTTP ${res.status}: ${res.statusText}`,
                rateLimitInfo,
            };
        }
        const detail = await discordErrorDetail(res);
        log('error', `Discord webhook returned status ${res.status} for username "${payload.username}": ${detail}`);
        return {
            success: false,
            error: `HTTP ${res.status}: ${detail}`,
            rateLimitInfo,
        };
    }
    catch (error) {
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
