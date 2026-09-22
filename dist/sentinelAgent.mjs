import { createSentinelAgent } from '@dark-avian-labs/sentinel-agent';
export function createAppSentinelAgent(options) {
    const token = options.token?.trim() ?? '';
    const ingestUrl = options.ingestUrl?.trim() ?? '';
    if (!token || !ingestUrl)
        return null;
    return createSentinelAgent({
        appId: options.appId,
        displayName: options.displayName,
        ingestUrl,
        token,
    });
}
