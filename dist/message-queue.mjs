import { DISCORD_EMBED_DESCRIPTION_LIMIT, fitDiscordPayload, messageFingerprint, moreEntriesLabel, } from './log-utils.mjs';
import { debug, log } from './logging.mjs';
const WEBHOOK_RATE_LIMIT = 30;
const WEBHOOK_RATE_WINDOW_SECONDS = 60;
const DEFAULT_TICK_INTERVAL_MS = 100;
const MAX_RETRY_ATTEMPTS = 5;
const DEFAULT_DELIVERY_RETRY_SECONDS = 60;
export const SEND_FAILED_EVENT = 'send_failed';
export const SEND_FAILED_DESCRIPTION = 'Something went wrong when trying to send a message. Please check the logs.';
export class MessageQueue {
    config;
    messageQueue = [];
    sender;
    requestHistory = [];
    discordRateLimit = null;
    flushInterval = null;
    isSending = false;
    webhookInvalid = false;
    bufferTimer = null;
    currentBuffer = [];
    backoffTimeout = null;
    requestsPerTick;
    tickIntervalMs;
    rateLimitedUntil = 0;
    characterCount = 0;
    isShuttingDown = false;
    recentSent = new Map();
    pendingMore = new Map();
    sendFailedMessage = null;
    deliveryRetryAt = 0;
    deliveryRetryMs;
    constructor(config, sender) {
        this.config = config;
        this.sender = sender;
        const messages = config.rate_limit_messages ?? WEBHOOK_RATE_LIMIT;
        const windowSeconds = config.rate_limit_window_seconds ?? WEBHOOK_RATE_WINDOW_SECONDS;
        const userRatePerSecond = messages / windowSeconds;
        const webhookMaxRatePerSecond = WEBHOOK_RATE_LIMIT / WEBHOOK_RATE_WINDOW_SECONDS;
        const safeRatePerSecond = Math.min(userRatePerSecond, webhookMaxRatePerSecond);
        if (safeRatePerSecond < 1) {
            this.requestsPerTick = 1;
            this.tickIntervalMs = Math.floor(1000 / safeRatePerSecond);
        }
        else {
            this.tickIntervalMs = DEFAULT_TICK_INTERVAL_MS;
            this.requestsPerTick = Math.max(1, Math.floor(safeRatePerSecond * (this.tickIntervalMs / 1000)));
        }
        this.deliveryRetryMs = Math.max(0, (config.delivery_retry_seconds ?? DEFAULT_DELIVERY_RETRY_SECONDS) * 1000);
    }
    getEffectiveRate() {
        return this.requestsPerTick * (1000 / this.tickIntervalMs);
    }
    getEffectiveWindow() {
        const windowSeconds = this.config.rate_limit_window_seconds ?? WEBHOOK_RATE_WINDOW_SECONDS;
        return windowSeconds * 1000;
    }
    isWebhookInvalid() {
        return this.webhookInvalid;
    }
    recordRequest(timestamp) {
        this.requestHistory.push({
            timestamp: timestamp || Date.now(),
            messageCount: 1,
        });
    }
    cleanupRequestHistory() {
        const now = Date.now();
        const window = this.getEffectiveWindow();
        this.requestHistory = this.requestHistory.filter((entry) => {
            return now - entry.timestamp < window;
        });
    }
    getRequestHistory() {
        return this.requestHistory;
    }
    canSendNow() {
        return Date.now() >= this.rateLimitedUntil;
    }
    getDelayUntilNextSend() {
        const now = Date.now();
        if (now >= this.rateLimitedUntil) {
            return 0;
        }
        return this.rateLimitedUntil - now;
    }
    collapseEnabled() {
        return this.config.collapse ?? true;
    }
    collapseWindowMs() {
        return (this.config.collapse_seconds ?? 60) * 1000;
    }
    formatEnabled() {
        return this.config.format ?? true;
    }
    bodyLimit() {
        return DISCORD_EMBED_DESCRIPTION_LIMIT - (this.formatEnabled() ? 6 : 0) - 24;
    }
    fingerprintOf(message) {
        return (message._fingerprint ?? messageFingerprint(message.name, message.event, message.description));
    }
    findUnsent(fingerprint) {
        return (this.currentBuffer.find((msg) => msg._fingerprint === fingerprint) ??
            this.messageQueue.find((msg) => msg._fingerprint === fingerprint));
    }
    descriptionWithCount(message) {
        const extra = (message._repeatCount ?? 1) - 1;
        const body = message.description ?? '';
        if (extra < 1) {
            return body;
        }
        return `${body}\n${moreEntriesLabel(extra)}`;
    }
    prepareForSend(message) {
        const asCodeBlock = this.formatEnabled() && message.event !== SEND_FAILED_EVENT;
        return {
            ...message,
            description: fitDiscordPayload(message.description ?? '', message._repeatCount ?? 1, asCodeBlock),
        };
    }
    recordSent(messages) {
        const now = Date.now();
        for (const message of messages) {
            const fingerprint = this.fingerprintOf(message);
            this.recentSent.set(fingerprint, {
                at: now,
                template: {
                    name: message.name,
                    event: message.event,
                    description: message.description,
                    timestamp: message.timestamp,
                },
            });
        }
    }
    flushPendingMore(fingerprint) {
        const pending = this.pendingMore.get(fingerprint);
        if (!pending) {
            return;
        }
        this.pendingMore.delete(fingerprint);
        clearTimeout(pending.timer);
        if (pending.extra < 1) {
            return;
        }
        this.messageQueue.push({
            name: pending.template.name,
            event: pending.template.event,
            description: pending.template.description,
            timestamp: pending.template.timestamp ?? Math.floor(Date.now() / 1000),
            _repeatCount: pending.extra + 1,
            _fingerprint: fingerprint,
        });
        if (!this.isShuttingDown) {
            this.startInterval();
        }
    }
    tryCollapse(message) {
        if (!this.collapseEnabled()) {
            return false;
        }
        const fingerprint = this.fingerprintOf(message);
        message._fingerprint = fingerprint;
        const now = Date.now();
        const windowMs = this.collapseWindowMs();
        const unsent = this.findUnsent(fingerprint);
        if (unsent) {
            unsent._repeatCount = (unsent._repeatCount ?? 1) + 1;
            return true;
        }
        const recent = this.recentSent.get(fingerprint);
        if (recent && now - recent.at < windowMs) {
            const existing = this.pendingMore.get(fingerprint);
            if (existing) {
                existing.extra += 1;
                return true;
            }
            const remaining = Math.max(0, windowMs - (now - recent.at));
            const pending = {
                extra: 1,
                template: recent.template,
                timer: setTimeout(() => {
                    this.flushPendingMore(fingerprint);
                }, remaining),
            };
            this.pendingMore.set(fingerprint, pending);
            return true;
        }
        message._repeatCount = 1;
        return false;
    }
    dropQueuedWork() {
        this.messageQueue = [];
        this.currentBuffer = [];
        this.characterCount = 0;
        if (this.bufferTimer) {
            clearTimeout(this.bufferTimer);
            this.bufferTimer = null;
        }
        for (const pending of this.pendingMore.values()) {
            clearTimeout(pending.timer);
        }
        this.pendingMore.clear();
    }
    armSendFailedNotice() {
        this.dropQueuedWork();
        if (!this.sendFailedMessage) {
            this.sendFailedMessage = {
                name: 'pm2-discord',
                event: SEND_FAILED_EVENT,
                description: SEND_FAILED_DESCRIPTION,
                timestamp: Math.floor(Date.now() / 1000),
            };
            log('warn', 'Discord delivery failed. Dropping queued events and retrying a Send failed notice.');
        }
        this.deliveryRetryAt = Date.now() + this.deliveryRetryMs;
        if (!this.isShuttingDown) {
            this.startInterval();
        }
    }
    async processSendFailedNotice() {
        if (!this.sendFailedMessage || Date.now() < this.deliveryRetryAt) {
            return;
        }
        this.isSending = true;
        try {
            this.recordRequest();
            this.cleanupRequestHistory();
            const prepared = this.prepareForSend(this.sendFailedMessage);
            const result = await this.sender([prepared], this.config.discord_url);
            if (result.rateLimitInfo) {
                this.discordRateLimit = result.rateLimitInfo;
            }
            if (result.webhookInvalid) {
                log('error', 'Webhook marked as invalid. Stopping message processing.');
                this.webhookInvalid = true;
                this.sendFailedMessage = null;
                this.stopInterval();
                return;
            }
            if (result.rateLimited && result.retryAfter) {
                this.rateLimitedUntil = Date.now() + result.retryAfter * 1000;
                this.deliveryRetryAt = this.rateLimitedUntil;
                return;
            }
            if (result.success) {
                this.sendFailedMessage = null;
                this.deliveryRetryAt = 0;
                this.stopInterval();
                return;
            }
            this.deliveryRetryAt = Date.now() + this.deliveryRetryMs;
        }
        catch (error) {
            log('error', 'Error sending Send failed notice:', error);
            this.deliveryRetryAt = Date.now() + this.deliveryRetryMs;
        }
        finally {
            this.isSending = false;
        }
    }
    async processTick() {
        if (this.isSending || this.webhookInvalid || this.isShuttingDown) {
            return;
        }
        if (this.sendFailedMessage) {
            if (!this.canSendNow()) {
                this.deliveryRetryAt = Math.max(this.deliveryRetryAt, this.rateLimitedUntil);
            }
            await this.processSendFailedNotice();
            return;
        }
        if (!this.canSendNow()) {
            if (this.flushInterval) {
                this.stopInterval();
            }
            if (!this.isShuttingDown) {
                const delay = this.getDelayUntilNextSend();
                log('log', `In rate limit backoff, delaying next send by ${delay}ms`);
                this.backoffTimeout = setTimeout(() => {
                    this.backoffTimeout = null;
                    this.startInterval();
                }, delay);
            }
            return;
        }
        if (this.messageQueue.length === 0) {
            this.stopInterval();
            return;
        }
        this.isSending = true;
        try {
            const messagesToSend = this.messageQueue.splice(0, this.requestsPerTick);
            if (messagesToSend.length === 0) {
                return;
            }
            this.recordRequest();
            this.cleanupRequestHistory();
            const prepared = messagesToSend.map((msg) => this.prepareForSend(msg));
            const result = await this.sender(prepared, this.config.discord_url);
            if (result.rateLimitInfo) {
                this.discordRateLimit = result.rateLimitInfo;
            }
            if (result.webhookInvalid) {
                log('error', 'Webhook marked as invalid. Stopping message processing.');
                this.webhookInvalid = true;
                this.stopInterval();
                return;
            }
            if (result.rateLimited && result.retryAfter) {
                log('log', `Rate limited by Discord. Backing off for ${result.retryAfter}s`);
                this.rateLimitedUntil = Date.now() + result.retryAfter * 1000;
                messagesToSend.forEach((msg) => {
                    msg._retryAttempts = (msg._retryAttempts ?? 0) + 1;
                    if (msg._retryAttempts <= MAX_RETRY_ATTEMPTS) {
                        this.messageQueue.unshift(msg);
                    }
                    else {
                        log('warn', `Message exceeded max retry attempts (${MAX_RETRY_ATTEMPTS}), discarding`);
                    }
                });
            }
            else if (result.success) {
                this.recordSent(messagesToSend);
            }
            else if (!result.success) {
                let deliveryFailed = false;
                messagesToSend.forEach((msg) => {
                    msg._retryAttempts = (msg._retryAttempts ?? 0) + 1;
                    if (msg._retryAttempts <= MAX_RETRY_ATTEMPTS) {
                        this.messageQueue.unshift(msg);
                    }
                    else {
                        log('warn', `Message exceeded max retry attempts (${MAX_RETRY_ATTEMPTS}), discarding: ${result.error}`);
                        deliveryFailed = true;
                    }
                });
                if (deliveryFailed) {
                    this.armSendFailedNotice();
                }
            }
        }
        catch (error) {
            log('error', 'Error sending to Discord:', error);
        }
        finally {
            this.isSending = false;
        }
    }
    startInterval() {
        if (this.flushInterval || this.isShuttingDown) {
            return;
        }
        this.flushInterval = setInterval(() => {
            this.processTick().catch((err) => {
                log('error', 'Error in processTick:', err);
            });
        }, this.tickIntervalMs);
    }
    stopInterval() {
        if (this.flushInterval) {
            clearInterval(this.flushInterval);
            this.flushInterval = null;
        }
        if (this.bufferTimer) {
            clearTimeout(this.bufferTimer);
            this.bufferTimer = null;
        }
        if (this.backoffTimeout) {
            clearTimeout(this.backoffTimeout);
            this.backoffTimeout = null;
        }
    }
    beginShutdown() {
        this.isShuttingDown = true;
        for (const fingerprint of this.pendingMore.keys()) {
            this.flushPendingMore(fingerprint);
        }
        this.stopInterval();
    }
    flushBuffer() {
        this.characterCount = 0;
        if (this.currentBuffer.length === 0) {
            return;
        }
        if (this.currentBuffer.length === 1) {
            this.messageQueue.push(this.currentBuffer[0]);
        }
        else {
            const combinedMessage = {
                name: this.currentBuffer[0].name,
                event: this.currentBuffer[0].event,
                description: this.currentBuffer.map((m) => this.descriptionWithCount(m)).join('\n'),
                timestamp: this.currentBuffer[0].timestamp,
            };
            this.messageQueue.push(combinedMessage);
        }
        this.currentBuffer = [];
        if (!this.flushInterval) {
            this.startInterval();
        }
    }
    shouldFlushBuffer() {
        return (this.characterCount >= this.bodyLimit() ||
            this.currentBuffer.length >= (this.config.queue_max ?? 100));
    }
    addMessage(message) {
        if (this.isShuttingDown) {
            log('warn', 'Ignoring message received during shutdown');
            return;
        }
        if (this.sendFailedMessage) {
            debug('Dropping event; waiting to report a previous send failure');
            return;
        }
        const bufferEnabled = this.config.buffer ?? true;
        const bufferSeconds = this.config.buffer_seconds ?? 1;
        debug('Buffer is set to:', bufferEnabled, 'Buffer seconds:', bufferSeconds);
        if (typeof message.timestamp !== 'number' ||
            !Number.isFinite(message.timestamp) ||
            message.timestamp <= 0) {
            message.timestamp = Math.floor(Date.now() / 1000);
        }
        if (this.tryCollapse(message)) {
            return;
        }
        let newMessageLength = message.description?.length ?? 0;
        const bodyLimit = this.bodyLimit();
        if (newMessageLength > bodyLimit) {
            log('warn', 'Single message exceeds Discord character limit, truncating...');
            message.description =
                (message.description ?? '').slice(0, Math.max(0, bodyLimit - 3)) + '...';
            newMessageLength = message.description.length;
        }
        if (bufferEnabled) {
            const newlinesThatWillExist = this.currentBuffer.length;
            if (this.characterCount + newlinesThatWillExist + newMessageLength > this.bodyLimit()) {
                log('log', 'Adding this message would exceed the embed description limit, flushing current buffer first.');
                this.flushBuffer();
            }
            this.currentBuffer.push(message);
            this.characterCount += newMessageLength;
            if (this.shouldFlushBuffer()) {
                log('log', 'Buffer reached queue_max, flushing immediately.');
                if (this.bufferTimer) {
                    clearTimeout(this.bufferTimer);
                    this.bufferTimer = null;
                }
                this.flushBuffer();
                return;
            }
            if (this.bufferTimer) {
                clearTimeout(this.bufferTimer);
            }
            if (!this.isShuttingDown) {
                this.bufferTimer = setTimeout(() => {
                    this.flushBuffer();
                }, bufferSeconds * 1000);
            }
        }
        else {
            this.messageQueue.push(message);
            if (!this.flushInterval) {
                this.startInterval();
            }
        }
    }
    async flush() {
        await this.processTick();
    }
}
