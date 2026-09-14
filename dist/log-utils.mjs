import stripAnsi from 'strip-ansi';
export const DISCORD_MESSAGE_CHAR_LIMIT = 2000;
const PM2_DATE_PREFIX = /([0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{1,2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})? [+-]?[0-9]{1,2}:[0-9]{2}(\.[0-9]{3})?)[:\s-]+/;
const PM2_DATE_GLOBAL = new RegExp(PM2_DATE_PREFIX.source, 'g');
const ISO_DATE_GLOBAL = /\d{4}-\d{2}-\d{2}T[^\s]+/g;
export async function parseIncomingLog(logMessage) {
    let description = null;
    let timestamp = null;
    if (typeof logMessage === 'string') {
        const parsedDescription = PM2_DATE_PREFIX.exec(logMessage);
        if (parsedDescription && parsedDescription.length >= 2) {
            timestamp = Math.floor(Date.parse(parsedDescription[1]) / 1000);
            description = stripAnsi(logMessage.replace(parsedDescription[0], ''));
        }
        else {
            description = stripAnsi(logMessage);
        }
    }
    return {
        description,
        timestamp,
    };
}
export function unwrapCodeFence(text) {
    const trimmed = text.trim();
    if (trimmed.startsWith('```') && trimmed.endsWith('```') && trimmed.length >= 6) {
        return trimmed.slice(3, -3);
    }
    return text;
}
export function moreEntriesLabel(extra) {
    return extra === 1 ? '[1 more entry]' : `[${extra} more entries]`;
}
export function normalizeForCollapse(text) {
    PM2_DATE_GLOBAL.lastIndex = 0;
    ISO_DATE_GLOBAL.lastIndex = 0;
    return unwrapCodeFence(text)
        .replace(PM2_DATE_GLOBAL, '')
        .replace(ISO_DATE_GLOBAL, '')
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '#')
        .replace(/0x[0-9a-f]+/gi, '#')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}
export function messageFingerprint(name, event, description) {
    return `${name}\n${event}\n${normalizeForCollapse(description ?? '')}`;
}
export function fitDiscordPayload(body, extraCount, asCodeBlock) {
    const extra = extraCount > 1 ? `\n${moreEntriesLabel(extraCount - 1)}` : '';
    const open = asCodeBlock ? '```' : '';
    const close = asCodeBlock ? '```' : '';
    const maxInner = DISCORD_MESSAGE_CHAR_LIMIT - open.length - close.length - extra.length;
    const inner = body.length > maxInner ? body.slice(0, Math.max(0, maxInner - 3)) + '...' : body;
    return open + inner + close + extra;
}
export function parseProcessName(process) {
    const suffix = process.exec_mode === 'cluster_mode' && process.instances > 1 ? `[${process.pm_id}]` : '';
    return process.name + suffix;
}
export function checkProcessName(data, configProcessName = null) {
    if (data.process.name === 'pm2-discord') {
        return false;
    }
    if (typeof configProcessName === 'string' && data.process.name !== configProcessName) {
        return false;
    }
    if (Array.isArray(configProcessName) && !configProcessName.includes(data.process.name)) {
        return false;
    }
    return true;
}
