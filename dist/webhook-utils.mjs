import { log } from './logging.mjs';
const DISCORD_WEBHOOK_HOSTS = new Set([
    'discord.com',
    'canary.discord.com',
    'ptb.discord.com',
    'discordapp.com',
]);
export function isValidDiscordWebhookUrl(url) {
    if (typeof url !== 'string' || !url.trim()) {
        log('error', '"discord_url" is required and is undefined.');
        log('error', 'Set the Discord URL using the following command:');
        log('error', 'pm2 set pm2-discord:discord_url <your discord webhook url>');
        return false;
    }
    try {
        const parsed = new URL(url);
        const debugEnv = process.env['PM2_DISCORD_DEBUG'];
        const allowLocal = process.env['NODE_ENV'] === 'test' || debugEnv === '1' || debugEnv?.toLowerCase() === 'true';
        if (allowLocal && parsed.hostname === '127.0.0.1') {
            return true;
        }
        if (parsed.protocol !== 'https:') {
            log('warn', 'Discord URL must use HTTPS protocol');
            return false;
        }
        if (!DISCORD_WEBHOOK_HOSTS.has(parsed.hostname)) {
            log('warn', 'Discord URL must be from discord.com or discordapp.com domain');
            return false;
        }
        if (!parsed.pathname || parsed.pathname === '/') {
            log('warn', 'Discord URL must include the webhook endpoint');
            return false;
        }
        return true;
    }
    catch {
        log('warn', 'Invalid Discord URL format');
        return false;
    }
}
