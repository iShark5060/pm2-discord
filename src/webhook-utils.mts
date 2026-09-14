import { log } from './logging.mjs';

/**
 * Validates that a URL is a valid Discord webhook URL.
 * Prevents SSRF attacks by ensuring the URL is HTTPS and from Discord's domain.
 */
export function isValidDiscordWebhookUrl(url: string | null): url is string {
  if (typeof url !== 'string' || !url.trim()) {
    log('error', '"discord_url" is required and is undefined.');
    log('error', 'Set the Discord URL using the following command:');
    log('error', 'pm2 set pm2-discord:discord_url <your discord webhook url>');
    return false;
  }

  const debugEnv = process.env['PM2_DISCORD_DEBUG'];
  const allowLocal =
    process.env['NODE_ENV'] === 'test' || debugEnv === '1' || debugEnv?.toLowerCase() === 'true';
  if (allowLocal && url.includes('http://127.0.0.1')) {
    return true;
  }

  try {
    const parsed = new URL(url);

    // Must use HTTPS for security
    if (parsed.protocol !== 'https:') {
      log('warn', 'Discord URL must use HTTPS protocol');
      return false;
    }

    // Must be from Discord's domain
    if (!parsed.hostname.includes('discord.com') && !parsed.hostname.includes('discordapp.com')) {
      log('warn', 'Discord URL must be from discord.com or discordapp.com domain');
      return false;
    }

    // Must have a pathname (webhook endpoint)
    if (!parsed.pathname || parsed.pathname === '/') {
      log('warn', 'Discord URL must include the webhook endpoint');
      return false;
    }

    return true;
  } catch {
    log('warn', 'Invalid Discord URL format');
    return false;
  }
}
