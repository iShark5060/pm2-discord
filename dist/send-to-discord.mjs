import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
function readRetryAfter(body) {
    if (typeof body !== 'object' || body === null) {
        return { retryAfter: 0, isGlobal: false };
    }
    const retryAfter = 'retry_after' in body && typeof body.retry_after === 'number' ? body.retry_after : 0;
    const isGlobal = 'global' in body && Boolean(body.global);
    return { retryAfter, isGlobal };
}
export function getUserName(messages) {
    const names = new Set(messages.map((msg) => msg.name.trim()).filter((name) => name.length > 0));
    return Array.from(names).join(', ') || 'PM2 Discord Bot';
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
    const payload = {
        content: messages.map((msg) => msg.description || '').join('\n'),
        username: getUserName(messages),
    };
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
        log('error', `Discord webhook returned status ${res.status}: ${res.statusText}`);
        return {
            success: false,
            error: `HTTP ${res.status}: ${res.statusText}`,
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
