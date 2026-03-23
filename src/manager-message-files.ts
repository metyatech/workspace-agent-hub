import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildManagerMessagePromptContent,
  type ManagerMessageAttachment,
} from './manager-message.js';

export interface ManagerPromptImageFile {
  id: string;
  name: string;
  mimeType: string;
  path: string;
}

const MIME_TO_EXTENSION = new Map<string, string>([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/jpg', '.jpg'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
  ['image/svg+xml', '.svg'],
]);

function sanitizeFileStem(name: string): string {
  const rawStem = basename(name, extname(name))
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return rawStem || 'image';
}

function extensionForAttachment(attachment: ManagerMessageAttachment): string {
  const lowerMime = attachment.mimeType.trim().toLowerCase();
  const mimeExtension = MIME_TO_EXTENSION.get(lowerMime);
  if (mimeExtension) {
    return mimeExtension;
  }
  const nameExtension = extname(attachment.name.trim());
  return nameExtension || '.png';
}

function decodeDataUrl(dataUrl: string): Buffer {
  const match = dataUrl.match(/^data:image\/[a-z0-9.+-]+;base64,(.+)$/i);
  if (!match?.[1]) {
    throw new Error('Unsupported image data URL');
  }
  return Buffer.from(match[1], 'base64');
}

export async function materializeManagerPromptImages(input: {
  workspaceKey: string;
  message: string;
}): Promise<ManagerPromptImageFile[]> {
  const prompt = buildManagerMessagePromptContent(input.message);
  if (prompt.images.length === 0) {
    return [];
  }

  const targetDir = join(
    tmpdir(),
    'workspace-agent-hub',
    'manager-message-images',
    input.workspaceKey
  );
  await mkdir(targetDir, { recursive: true });

  return Promise.all(
    prompt.images.map(async (attachment) => {
      const contentHash = createHash('sha256')
        .update(attachment.dataUrl)
        .digest('hex')
        .slice(0, 16);
      const targetPath = join(
        targetDir,
        `${sanitizeFileStem(attachment.name)}-${contentHash}${extensionForAttachment(
          attachment
        )}`
      );
      await writeFile(targetPath, decodeDataUrl(attachment.dataUrl));
      return {
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        path: targetPath,
      };
    })
  );
}
