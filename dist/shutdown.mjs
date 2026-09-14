import { log } from './logging.mjs';
const SHUTDOWN_TIMEOUT_MS = 5000;
const MAX_SHUTDOWN_ATTEMPTS = 50;
const SHUTDOWN_RETRY_DELAY_MS = 50;
export async function gracefulShutdown(messageQueue) {
    if (!messageQueue) {
        process.exit(0);
    }
    log('log', 'Caught shutdown signal, flushing message queue before exit.');
    const queue = messageQueue;
    queue.beginShutdown();
    queue.flushBuffer();
    const startTime = Date.now();
    let attempts = 0;
    while (queue.messageQueue.length > 0 &&
        !queue.webhookInvalid &&
        attempts < MAX_SHUTDOWN_ATTEMPTS) {
        if (Date.now() - startTime > SHUTDOWN_TIMEOUT_MS) {
            log('warn', 'Shutdown timeout reached, exiting with remaining messages');
            break;
        }
        await queue.processTick();
        attempts++;
        await new Promise((r) => setTimeout(r, SHUTDOWN_RETRY_DELAY_MS));
    }
    log('log', 'Message queue flushed, exiting.');
    process.exit(0);
}
