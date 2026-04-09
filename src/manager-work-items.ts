import { resolve as resolvePath } from 'node:path';
import { listThreads } from '@metyatech/thread-inbox';
import { readQueue, readSession } from './manager-backend.js';
import {
  deriveManagerThreadViews,
  reconcileManagerThreadMeta,
  readManagerThreadMeta,
  type ManagerThreadView,
} from './manager-thread-state.js';

export async function readManagerWorkItems(
  dir: string
): Promise<ManagerThreadView[]> {
  const workspaceRoot = resolvePath(dir);
  const [threads, session, queue, rawMeta] = await Promise.all([
    listThreads(workspaceRoot),
    readSession(workspaceRoot),
    readQueue(workspaceRoot),
    readManagerThreadMeta(workspaceRoot),
  ]);
  const meta = await reconcileManagerThreadMeta({
    dir: workspaceRoot,
    session,
    queue,
    meta: rawMeta,
  });

  return deriveManagerThreadViews({
    threads,
    session,
    queue,
    meta,
  });
}
