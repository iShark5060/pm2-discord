export function debug(...args) {
    const debugEnv = process.env['PM2_DISCORD_DEBUG'];
    if (debugEnv && (debugEnv === '1' || debugEnv.toLowerCase() === 'true')) {
        console.debug(`pm2-discord [DEBUG]: ${new Date().toISOString()} - `, ...args);
    }
}
export function log(level, ...args) {
    const timestamp = `pm2-discord [${level.toUpperCase()}]: ${new Date().toISOString()} - `;
    console[level](timestamp, ...args);
}
