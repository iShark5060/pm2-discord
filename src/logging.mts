/**
 * Wrapper around console.debug that only logs if `PM2_DISCORD_DEBUG` env var is set.
 * `PM2_DISCORD_DEBUG` must be '1' or 'true' (case insensitive) to enable debug logging.
 */
export function debug(...args: unknown[]): void {
  const debugEnv = process.env['PM2_DISCORD_DEBUG'];
  if (debugEnv && (debugEnv === '1' || debugEnv.toLowerCase() === 'true')) {
    console.debug(`pm2-discord [DEBUG]: ${new Date().toISOString()} - `, ...args);
  }
}

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error' | 'debug';

export function log(level: ConsoleMethod, ...args: unknown[]): void {
  const timestamp = `pm2-discord [${level.toUpperCase()}]: ${new Date().toISOString()} - `;
  console[level](timestamp, ...args);
}
