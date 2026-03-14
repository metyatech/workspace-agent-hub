import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export interface WebUiAuthConfig {
  required: boolean;
  token: string | null;
  storageKey: string;
}

export function resolveWebUiAuthConfig(
  workspaceRoot: string,
  authTokenOption?: string
): WebUiAuthConfig {
  const raw = (authTokenOption ?? 'auto').trim();
  const shouldRequire = raw.toLowerCase() !== 'none';
  const token = !shouldRequire
    ? null
    : raw.toLowerCase() === 'auto'
      ? randomBytes(12).toString('base64url')
      : raw;

  return {
    required: shouldRequire,
    token,
    storageKey: `workspace-agent-hub.token:${workspaceRoot}`,
  };
}

export function isWebUiAuthorized(
  req: IncomingMessage,
  config: WebUiAuthConfig
): boolean {
  if (!config.required || !config.token) {
    return true;
  }

  const headerValue = req.headers['x-workspace-agent-hub-token'];
  if (typeof headerValue === 'string' && headerValue === config.token) {
    return true;
  }

  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length) === config.token;
  }

  return false;
}
