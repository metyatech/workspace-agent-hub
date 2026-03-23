import { resolve as resolvePath } from 'node:path';

type HubUpdateListener = () => void | Promise<void>;

interface HubUpdateChannel {
  listeners: Set<HubUpdateListener>;
  timer: NodeJS.Timeout | null;
}

const channels = new Map<string, HubUpdateChannel>();

function getOrCreateChannel(workspaceRoot: string): HubUpdateChannel {
  const key = resolvePath(workspaceRoot);
  const existing = channels.get(key);
  if (existing) {
    return existing;
  }
  const created: HubUpdateChannel = {
    listeners: new Set(),
    timer: null,
  };
  channels.set(key, created);
  return created;
}

function emitHubUpdate(workspaceRoot: string): void {
  const channel = channels.get(resolvePath(workspaceRoot));
  if (!channel) {
    return;
  }
  for (const listener of [...channel.listeners]) {
    try {
      void listener();
    } catch {
      /* ignore listener failures */
    }
  }
}

function scheduleHubUpdate(workspaceRoot: string): void {
  const key = resolvePath(workspaceRoot);
  const channel = getOrCreateChannel(key);
  if (channel.timer) {
    clearTimeout(channel.timer);
  }
  channel.timer = setTimeout(() => {
    channel.timer = null;
    emitHubUpdate(key);
  }, 40);
}

export function subscribeHubUpdates(
  workspaceRoot: string,
  listener: HubUpdateListener
): () => void {
  const key = resolvePath(workspaceRoot);
  const channel = getOrCreateChannel(key);
  channel.listeners.add(listener);
  return () => {
    const current = channels.get(key);
    if (!current) {
      return;
    }
    current.listeners.delete(listener);
    if (current.listeners.size > 0) {
      return;
    }
    if (current.timer) {
      clearTimeout(current.timer);
    }
    channels.delete(key);
  };
}

export function notifyHubUpdate(workspaceRoot: string): void {
  scheduleHubUpdate(resolvePath(workspaceRoot));
}
