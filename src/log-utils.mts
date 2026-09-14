import stripAnsi from 'strip-ansi';

import type { BusData, LogMessage, Process } from './types/index.js';

export const DISCORD_MESSAGE_CHAR_LIMIT = 2000;

const PM2_DATE_PREFIX =
  /([0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{1,2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})? [+-]?[0-9]{1,2}:[0-9]{2}(\.[0-9]{3})?)[:\s-]+/;
const PM2_DATE_GLOBAL = new RegExp(PM2_DATE_PREFIX.source, 'g');
const ISO_DATE_GLOBAL = /\d{4}-\d{2}-\d{2}T[^\s]+/g;

/**
 * PM2 stores log messages with date in format "YYYY-MM-DD hh:mm:ss +-zz:zz"
 * This function extracts the timestamp and removes it from the message text,
 * then strips ANSI color codes for clean Discord display.
 *
 * Formatting as a code block happens later, when the payload is built, so a
 * truncated message can still close its fence.
 */
export async function parseIncomingLog(logMessage: string): Promise<LogMessage> {
  let description: string | null = null;
  let timestamp: number | null = null;

  if (typeof logMessage === 'string') {
    const parsedDescription = PM2_DATE_PREFIX.exec(logMessage);
    if (parsedDescription && parsedDescription.length >= 2) {
      timestamp = Math.floor(Date.parse(parsedDescription[1]) / 1000);
      description = stripAnsi(logMessage.replace(parsedDescription[0], ''));
    } else {
      description = stripAnsi(logMessage);
    }
  }

  return {
    description,
    timestamp,
  };
}

export function unwrapCodeFence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('```') && trimmed.endsWith('```') && trimmed.length >= 6) {
    return trimmed.slice(3, -3);
  }
  return text;
}

export function moreEntriesLabel(extra: number): string {
  return extra === 1 ? '[1 more entry]' : `[${extra} more entries]`;
}

export function normalizeForCollapse(text: string): string {
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

export function messageFingerprint(
  name: string,
  event: string,
  description: string | null,
): string {
  return `${name}\n${event}\n${normalizeForCollapse(description ?? '')}`;
}

/**
 * Build a Discord content string that never exceeds 2000 characters and always
 * closes a code fence when wrapping is on. Repeat count sits outside the fence
 * so it stays readable after truncation.
 */
export function fitDiscordPayload(body: string, extraCount: number, asCodeBlock: boolean): string {
  const extra = extraCount > 1 ? `\n${moreEntriesLabel(extraCount - 1)}` : '';
  const open = asCodeBlock ? '```' : '';
  const close = asCodeBlock ? '```' : '';
  const maxInner = DISCORD_MESSAGE_CHAR_LIMIT - open.length - close.length - extra.length;
  const inner = body.length > maxInner ? body.slice(0, Math.max(0, maxInner - 3)) + '...' : body;
  return open + inner + close + extra;
}

/**
 * Generates display name for a PM2 process.
 * In cluster mode with multiple instances, appends [pm_id] to distinguish between workers.
 * This helps identify which specific instance generated a log message.
 *
 * @param process - PM2 process metadata including exec_mode, instances, and pm_id
 * @returns Display name - either "process-name" or "process-name[pm_id]" for clusters
 * @example
 * // Single instance: { name: "api", exec_mode: "fork_mode" } => "api"
 * // Cluster mode: { name: "api", exec_mode: "cluster_mode", instances: 4, pm_id: 2 } => "api[2]"
 */
export function parseProcessName(process: Process): string {
  const suffix =
    process.exec_mode === 'cluster_mode' && process.instances > 1 ? `[${process.pm_id}]` : '';
  return process.name + suffix;
}

/**
 * Checks if a PM2 process should have its messages forwarded to Discord.
 * Filters out messages from pm2-discord itself to prevent recursion,
 * and optionally filters by specific process name if configured.
 *
 * @param data - PM2 bus data containing process information
 * @returns true if messages from this process should be forwarded, false otherwise
 * @example
 * // Always filters out self:
 * checkProcessName({ process: { name: 'pm2-discord' } }) // => false
 *
 * // Filters by process_name if configured:
 * config.process_name = 'api';
 * checkProcessName({ process: { name: 'api' } })    // => true
 * checkProcessName({ process: { name: 'worker' } }) // => false
 */
export function checkProcessName(
  data: BusData,
  configProcessName: string | string[] | null = null,
): boolean {
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
