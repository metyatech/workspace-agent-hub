import { watch, type FSWatcher } from 'node:fs';
import { basename, relative, resolve as resolvePath } from 'node:path';
import type { HubLiveUpdateWatchConfig } from './types.js';

type HubUpdateListener = () => void | Promise<void>;

interface HubUpdateChannel {
  listeners: Set<HubUpdateListener>;
  timer: NodeJS.Timeout | null;
  watcher: FSWatcher | null;
  watchConfigSignature: string | null;
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
    watcher: null,
    watchConfigSignature: null,
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

function normalizeRelativePath(pathText: string): string {
  return pathText
    .replace(/[\\/]+/g, '/')
    .replace(/^\.?\//, '')
    .toLowerCase();
}

function isRelevantWatchEvent(
  watchConfig: HubLiveUpdateWatchConfig,
  fileName: string
): boolean {
  const relativePath = normalizeRelativePath(fileName);
  if (!relativePath) {
    return false;
  }

  const normalizedCatalog = normalizeRelativePath(
    relative(watchConfig.watchRootPath, watchConfig.sessionCatalogPath)
  );
  if (relativePath === normalizedCatalog) {
    return true;
  }

  const normalizedSessionLiveDir = normalizeRelativePath(
    relative(watchConfig.watchRootPath, watchConfig.sessionLiveDirPath)
  );
  return (
    relativePath === normalizedSessionLiveDir ||
    relativePath.startsWith(`${normalizedSessionLiveDir}/`)
  );
}

function watchConfigSignature(watchConfig: HubLiveUpdateWatchConfig): string {
  return JSON.stringify({
    watchRootPath: resolvePath(watchConfig.watchRootPath),
    sessionCatalogPath: resolvePath(watchConfig.sessionCatalogPath),
    sessionLiveDirPath: resolvePath(watchConfig.sessionLiveDirPath),
  });
}

function ensureHubWatcher(
  workspaceRoot: string,
  watchConfig: HubLiveUpdateWatchConfig | null | undefined
): void {
  const resolvedRoot = resolvePath(workspaceRoot);
  const channel = getOrCreateChannel(resolvedRoot);
  const signature = watchConfig ? watchConfigSignature(watchConfig) : null;
  if (channel.watcher && channel.watchConfigSignature === signature) {
    return;
  }

  channel.watcher?.close();
  channel.watcher = null;
  channel.watchConfigSignature = signature;

  if (!watchConfig) {
    return;
  }

  try {
    channel.watcher = watch(
      resolvePath(watchConfig.watchRootPath),
      { persistent: false, recursive: true },
      (_eventType, fileName) => {
        const normalizedName =
          typeof fileName === 'string'
            ? fileName
            : basename(String(fileName ?? ''));
        if (!normalizedName) {
          return;
        }
        if (!isRelevantWatchEvent(watchConfig, normalizedName)) {
          return;
        }
        scheduleHubUpdate(resolvedRoot);
      }
    );
    channel.watcher.on('error', () => {
      /* ignore watcher failures */
    });
  } catch {
    channel.watcher = null;
  }
}

export function subscribeHubUpdates(
  workspaceRoot: string,
  listener: HubUpdateListener,
  watchConfig?: HubLiveUpdateWatchConfig | null
): () => void {
  const key = resolvePath(workspaceRoot);
  const channel = getOrCreateChannel(key);
  channel.listeners.add(listener);
  ensureHubWatcher(key, watchConfig);
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
    current.watcher?.close();
    channels.delete(key);
  };
}

export function notifyHubUpdate(workspaceRoot: string): void {
  scheduleHubUpdate(resolvePath(workspaceRoot));
}
