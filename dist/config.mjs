import { debug, log } from './logging.mjs';
const MIN_BUFFER_SECONDS = 1;
const MAX_BUFFER_SECONDS = 5;
const MIN_QUEUE_MAX = 10;
const MAX_QUEUE_MAX = 100;
const MIN_COLLAPSE_SECONDS = 1;
const MAX_COLLAPSE_SECONDS = 300;
export const defaultConfig = {
    log: false,
    error: true,
    kill: true,
    exception: true,
    restart: true,
    delete: false,
    stop: true,
    'restart overlimit': true,
    exit: false,
    start: false,
    online: false,
    process_name: null,
    discord_url: null,
    sentinel_ingest_url: null,
    sentinel_ingest_token: null,
    buffer: true,
    buffer_seconds: 1,
    queue_max: 100,
    rate_limit_messages: 30,
    rate_limit_window_seconds: 60,
    format: true,
    collapse: true,
    collapse_seconds: 60,
};
function clamp(num, min, max) {
    return Math.min(Math.max(num, min), max);
}
export function convertConfigValue(key, value) {
    const booleanKeys = new Set([
        'log',
        'error',
        'kill',
        'exception',
        'restart',
        'delete',
        'stop',
        'restart overlimit',
        'exit',
        'start',
        'online',
        'buffer',
        'format',
        'collapse',
    ]);
    const numericKeys = new Set([
        'buffer_seconds',
        'queue_max',
        'rate_limit_messages',
        'rate_limit_window_seconds',
        'collapse_seconds',
    ]);
    if (booleanKeys.has(key)) {
        if (typeof value === 'boolean')
            return value;
        if (typeof value === 'string') {
            const lower = value.toLowerCase().trim();
            return lower === 'true' || lower === '1';
        }
        return Boolean(value);
    }
    if (numericKeys.has(key)) {
        if (typeof value === 'number')
            return value;
        if (typeof value === 'string') {
            const num = Number(value.trim());
            return isNaN(num) ? undefined : num;
        }
        return undefined;
    }
    return value;
}
let cachedConfig = null;
export function loadConfig(refresh = false) {
    if (cachedConfig && !refresh) {
        return cachedConfig;
    }
    const rawConfig = {};
    const configFromEnv = process.env['pm2-discord'];
    debug(`process.env['pm2-discord'] = ${configFromEnv}`);
    try {
        if (configFromEnv) {
            const parsed = JSON.parse(configFromEnv);
            if (typeof parsed === 'object' && parsed !== null) {
                Object.assign(rawConfig, parsed);
            }
        }
    }
    catch (e) {
        log('error', 'Error parsing module config from env:', e);
    }
    const moduleConfig = {};
    for (const key in rawConfig) {
        const convertedValue = convertConfigValue(key, rawConfig[key]);
        if (convertedValue !== undefined) {
            moduleConfig[key] = convertedValue;
        }
    }
    debug('moduleConfig from env with corrected types:', moduleConfig);
    const finalConfig = { ...defaultConfig, ...moduleConfig };
    finalConfig.buffer_seconds = clamp(finalConfig.buffer_seconds, MIN_BUFFER_SECONDS, MAX_BUFFER_SECONDS);
    finalConfig.queue_max = clamp(finalConfig.queue_max, MIN_QUEUE_MAX, MAX_QUEUE_MAX);
    finalConfig.collapse_seconds = clamp(finalConfig.collapse_seconds, MIN_COLLAPSE_SECONDS, MAX_COLLAPSE_SECONDS);
    debug('finalConfig after merge and clamp:', finalConfig);
    cachedConfig = finalConfig;
    return finalConfig;
}
