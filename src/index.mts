import pm2 from 'pm2';
import pmx from 'pmx';
import stripAnsi from 'strip-ansi';

import { loadConfig } from './config.mjs';
import { checkProcessName, parseIncomingLog, parseProcessName } from './log-utils.mjs';
import { debug, log } from './logging.mjs';
import { MessageQueue } from './message-queue.mjs';
import { sendToDiscord } from './send-to-discord.mjs';
import { createAppSentinelAgent } from './sentinelAgent.mjs';
import { gracefulShutdown } from './shutdown.mjs';
import type { BusData, Config, Pm2Bus } from './types/index.js';
import { isValidDiscordWebhookUrl } from './webhook-utils.mjs';

const config = loadConfig();
const discordUrl = config.discord_url;

if (!isValidDiscordWebhookUrl(discordUrl)) {
  process.exit(1);
}

const sentinelAgent = createAppSentinelAgent({
  appId: 'pm2-discord',
  displayName: 'pm2-discord',
  ingestUrl: config.sentinel_ingest_url,
  token: config.sentinel_ingest_token,
});
sentinelAgent?.start();

const configFromInit = pmx.initModule(null, onInit);
debug('pm2-discord: Module initialized with config:', configFromInit);

function busLogText(data: unknown): string {
  return typeof data === 'string' ? data : '';
}

function killMessage(data: BusData): string {
  return data.msg ?? '';
}

function exceptionText(data: unknown): string {
  if (
    typeof data === 'object' &&
    data !== null &&
    'message' in data &&
    typeof data.message === 'string'
  ) {
    const code = 'code' in data && data.code != null ? String(data.code) : '';
    return code + data.message;
  }
  return JSON.stringify(data);
}

function onInit() {
  const messageQueue = new MessageQueue(
    {
      discord_url: discordUrl,
      rate_limit_messages: config.rate_limit_messages,
      rate_limit_window_seconds: config.rate_limit_window_seconds,
      buffer: config.buffer,
      buffer_seconds: config.buffer_seconds,
      queue_max: config.queue_max,
      collapse: config.collapse,
      collapse_seconds: config.collapse_seconds,
      format: config.format,
    },
    sendToDiscord,
  );

  const handleShutdown = () =>
    gracefulShutdown(messageQueue, sentinelAgent).catch((e) => {
      log('error', 'Error during graceful shutdown:', e);
      sentinelAgent?.noteCrash(e);
      sentinelAgent?.stop();
      process.exit(1);
    });
  process.on('SIGINT', handleShutdown);
  process.on('SIGTERM', handleShutdown);
  process.on('unhandledRejection', (reason) => {
    sentinelAgent?.noteCrash(reason);
  });
  process.on('uncaughtException', (err) => {
    sentinelAgent?.noteCrash(err);
  });

  pm2.launchBus(function (_err: Error | null, bus: Pm2Bus) {
    if (config.log) {
      bus.on('log:out', async function (data: BusData) {
        if (!checkProcessName(data, config.process_name)) {
          return;
        }

        const parsedLog = await parseIncomingLog(busLogText(data.data));
        messageQueue.addMessage({
          name: parseProcessName(data.process),
          event: 'log',
          description: parsedLog.description,
          timestamp: parsedLog.timestamp,
        });
      });
    }

    if (config.error) {
      bus.on('log:err', async function (data: BusData) {
        if (!checkProcessName(data, config.process_name)) {
          return;
        }

        const parsedLog = await parseIncomingLog(busLogText(data.data));
        messageQueue.addMessage({
          name: parseProcessName(data.process),
          event: 'error',
          description: parsedLog.description,
          timestamp: parsedLog.timestamp,
        });
      });
    }

    if (config.kill) {
      bus.on('pm2:kill', function (data: BusData) {
        const msg = killMessage(data);
        messageQueue.addMessage({
          name: 'PM2',
          event: 'kill',
          description: msg,
          timestamp: Math.floor(Date.now() / 1000),
        });
      });
    }

    if (config.exception) {
      bus.on('process:exception', async function (data: BusData) {
        if (!checkProcessName(data, config.process_name)) {
          return;
        }

        const rawDescription = exceptionText(data.data);
        const description = stripAnsi(rawDescription);
        messageQueue.addMessage({
          name: parseProcessName(data.process),
          event: 'exception',
          description,
          timestamp: Math.floor(Date.now() / 1000),
        });
      });
    }

    bus.on('process:event', function (data: BusData) {
      const eventName = data.event ?? '';
      const setting = eventName ? config[eventName as keyof Config] : undefined;
      if (typeof setting === 'boolean' && !setting) {
        return;
      }
      if (!checkProcessName(data, config.process_name)) {
        return;
      }
      const message = `The following event has occurred on the PM2 process ${data.process.name}: ${eventName}`;
      messageQueue.addMessage({
        name: parseProcessName(data.process),
        event: eventName,
        description: message,
        timestamp: Math.floor(Date.now() / 1000),
      });
    });
  });
}
