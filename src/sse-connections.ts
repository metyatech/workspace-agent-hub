import type { ServerResponse } from 'node:http';

/**
 * Shared set of active SSE response streams, used by both web-ui.ts and
 * manager-ui.ts so that graceful shutdown can destroy all connections.
 */
export const activeSseConnections = new Set<ServerResponse>();
