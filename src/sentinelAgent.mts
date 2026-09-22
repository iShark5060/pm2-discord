import { createSentinelAgent } from '@dark-avian-labs/sentinel-agent';

type AgentHandle = ReturnType<typeof createSentinelAgent>;

export function createAppSentinelAgent(options: {
  appId: string;
  displayName: string;
  ingestUrl: string | null | undefined;
  token: string | null | undefined;
}): AgentHandle | null {
  const token = options.token?.trim() ?? '';
  const ingestUrl = options.ingestUrl?.trim() ?? '';
  if (!token || !ingestUrl) return null;
  return createSentinelAgent({
    appId: options.appId,
    displayName: options.displayName,
    ingestUrl,
    token,
  });
}
