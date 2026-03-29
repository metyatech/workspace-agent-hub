import { watch, type FSWatcher } from 'node:fs';
import { basename, resolve as resolvePath } from 'node:path';

type ManagerUpdateListener = () => void | Promise<void>;

interface WorkspaceUpdateChannel {
  listeners: Set<ManagerUpdateListener>;
  watcher: FSWatcher | null;
  timer: NodeJS.Timeout | null;
}

const WATCHED_FILENAMES = new Set([
  '.threads.jsonl',
  '.tasks.jsonl',
  '.workspace-agent-hub-manager.json',
  '.workspace-agent-hub-manager-queue.jsonl',
  '.workspace-agent-hub-manager-thread-meta.json',
]);

const channels = new Map<string, WorkspaceUpdateChannel>();

function getOrCreateChannel(workspaceRoot: string): WorkspaceUpdateChannel {
  const key = resolvePath(workspaceRoot);
  const existing = channels.get(key);
  if (existing) {
    return existing;
  }
  const created: WorkspaceUpdateChannel = {
    listeners: new Set(),
    watcher: null,
    timer: null,
  };
  channels.set(key, created);
  return created;
}

function emitWorkspaceUpdate(workspaceRoot: string): void {
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

function scheduleWorkspaceUpdate(workspaceRoot: string): void {
  const channel = channels.get(resolvePath(workspaceRoot));
  if (!channel) {
    return;
  }
  if (channel.timer) {
    clearTimeout(channel.timer);
  }
  channel.timer = setTimeout(() => {
    channel.timer = null;
    emitWorkspaceUpdate(workspaceRoot);
  }, 80);
}

function ensureWorkspaceWatcher(workspaceRoot: string): void {
  const resolvedRoot = resolvePath(workspaceRoot);
  const channel = getOrCreateChannel(resolvedRoot);
  if (channel.watcher) {
    return;
  }

  try {
    channel.watcher = watch(
      resolvedRoot,
      { persistent: false },
      (_eventType, fileName) => {
        const normalizedName =
          typeof fileName === 'string' ? basename(fileName) : '';
        if (!normalizedName || !WATCHED_FILENAMES.has(normalizedName)) {
          return;
        }
        scheduleWorkspaceUpdate(resolvedRoot);
      }
    );
    channel.watcher.on('error', () => {
      /* ignore watcher failures */
    });
  } catch {
    channel.watcher = null;
  }
}

export function subscribeManagerUpdates(
  workspaceRoot: string,
  listener: ManagerUpdateListener
): () => void {
  const resolvedRoot = resolvePath(workspaceRoot);
  const channel = getOrCreateChannel(resolvedRoot);
  channel.listeners.add(listener);
  ensureWorkspaceWatcher(resolvedRoot);

  return () => {
    const current = channels.get(resolvedRoot);
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
    channels.delete(resolvedRoot);
  };
}

export function notifyManagerUpdate(workspaceRoot: string): void {
  scheduleWorkspaceUpdate(resolvePath(workspaceRoot));
}
