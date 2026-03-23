const RICH_MESSAGE_META_PREFIX = '<!--workspace-agent-hub-rich-message:';
const RICH_MESSAGE_META_SUFFIX = '-->';

const RICH_MESSAGE_PATTERN =
  /([\s\S]*?)\n\n<!--workspace-agent-hub-rich-message:([\s\S]+?)-->\s*$/;

const ATTACHMENT_IMAGE_PATTERN = /!\[([^\]]*)\]\(attachment:\/\/([^)]+)\)/g;
const GENERIC_IMAGE_PATTERN = /!\[([^\]]*)\]\(([^)]+)\)/g;

export interface ManagerMessageAttachment {
  id: string;
  name: string;
  mimeType: string;
  dataUrl: string;
}

export interface ParsedManagerMessage {
  markdown: string;
  attachments: ManagerMessageAttachment[];
}

export interface ManagerPromptContent {
  text: string;
  images: ManagerMessageAttachment[];
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function isSafeDataImageUrl(value: string): boolean {
  return /^data:image\/[a-z0-9.+-]+;base64,/i.test(value.trim());
}

function normalizeAttachment(value: unknown): ManagerMessageAttachment | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  const id =
    typeof record['id'] === 'string'
      ? normalizeNewlines(record['id']).trim()
      : '';
  const name =
    typeof record['name'] === 'string'
      ? normalizeNewlines(record['name']).trim()
      : '';
  const mimeType =
    typeof record['mimeType'] === 'string'
      ? normalizeNewlines(record['mimeType']).trim()
      : '';
  const dataUrl =
    typeof record['dataUrl'] === 'string'
      ? normalizeNewlines(record['dataUrl']).trim()
      : '';

  if (!id || !name || !mimeType || !isSafeDataImageUrl(dataUrl)) {
    return null;
  }

  return {
    id,
    name,
    mimeType,
    dataUrl,
  };
}

function stripMarkdownDecoration(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (match) =>
      match.replace(/```/g, '').replace(/\n+/g, ' ')
    )
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/^ {0,3}(#{1,6}|>|\*|-|\+|\d+\.)\s+/gm, '')
    .replace(/[*_~]+/g, '');
}

function attachmentLabel(
  attachment: ManagerMessageAttachment | undefined,
  altText: string
): string {
  const alt = altText.trim();
  if (alt) {
    return alt;
  }
  return attachment?.name ?? 'image';
}

export function parseManagerMessage(raw: string): ParsedManagerMessage {
  const normalizedRaw = normalizeNewlines(raw);
  const matched = normalizedRaw.match(RICH_MESSAGE_PATTERN);
  if (!matched) {
    return {
      markdown: normalizedRaw,
      attachments: [],
    };
  }

  try {
    const parsedMeta = JSON.parse(matched[2]) as {
      attachments?: unknown[];
    };
    const attachments = Array.isArray(parsedMeta.attachments)
      ? parsedMeta.attachments.flatMap((value) => {
          const normalized = normalizeAttachment(value);
          return normalized ? [normalized] : [];
        })
      : [];
    return {
      markdown: matched[1],
      attachments,
    };
  } catch {
    return {
      markdown: normalizedRaw,
      attachments: [],
    };
  }
}

export function extractManagerMessageAttachmentIds(markdown: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const match of markdown.matchAll(ATTACHMENT_IMAGE_PATTERN)) {
    const id = match[2]?.trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function filterManagerMessageAttachments(input: {
  markdown: string;
  attachments: ManagerMessageAttachment[];
}): ManagerMessageAttachment[] {
  const ids = extractManagerMessageAttachmentIds(input.markdown);
  if (ids.length === 0 || input.attachments.length === 0) {
    return [];
  }

  const attachmentMap = new Map(
    input.attachments.map((attachment) => [attachment.id, attachment])
  );
  return ids.flatMap((id) => {
    const attachment = attachmentMap.get(id);
    return attachment ? [attachment] : [];
  });
}

export function serializeManagerMessage(input: {
  content: string;
  attachments?: ManagerMessageAttachment[];
}): string {
  const content = normalizeNewlines(input.content);
  const attachments = filterManagerMessageAttachments({
    markdown: content,
    attachments: input.attachments ?? [],
  });
  if (attachments.length === 0) {
    return content;
  }

  return `${content}\n\n${RICH_MESSAGE_META_PREFIX}${JSON.stringify({
    attachments,
  })}${RICH_MESSAGE_META_SUFFIX}`;
}

export function replaceManagerMessageImages(
  raw: string,
  replacer: (input: {
    attachment: ManagerMessageAttachment | undefined;
    altText: string;
    target: string;
    index: number;
  }) => string
): string {
  const parsed = parseManagerMessage(raw);
  const attachmentMap = new Map(
    parsed.attachments.map((attachment) => [attachment.id, attachment])
  );
  let index = 0;

  return parsed.markdown.replace(
    GENERIC_IMAGE_PATTERN,
    (_full, altText: string, target: string) => {
      index += 1;
      const attachment = target.startsWith('attachment://')
        ? attachmentMap.get(target.slice('attachment://'.length))
        : undefined;
      return replacer({
        attachment,
        altText,
        target,
        index,
      });
    }
  );
}

export function buildManagerMessagePromptContent(
  raw: string
): ManagerPromptContent {
  const parsed = parseManagerMessage(raw);
  const referencedAttachments = filterManagerMessageAttachments(parsed);
  const labelMap = new Map<string, number>();
  const images: ManagerMessageAttachment[] = [];

  const text = parsed.markdown.replace(
    GENERIC_IMAGE_PATTERN,
    (_full, altText: string, target: string) => {
      if (!target.startsWith('attachment://')) {
        return `[Image: ${altText.trim() || 'image'}]`;
      }

      const attachmentId = target.slice('attachment://'.length);
      const attachment = referencedAttachments.find(
        (value) => value.id === attachmentId
      );
      if (!attachment) {
        return `[Image: ${altText.trim() || 'image'}]`;
      }

      const existingIndex = labelMap.get(attachment.id);
      if (existingIndex) {
        return `[Image ${existingIndex}: ${attachmentLabel(attachment, altText)}]`;
      }

      const nextIndex = images.length + 1;
      labelMap.set(attachment.id, nextIndex);
      images.push(attachment);
      return `[Image ${nextIndex}: ${attachmentLabel(attachment, altText)}]`;
    }
  );

  if (images.length === 0) {
    return { text, images };
  }

  return {
    text: [
      text,
      '',
      'Attached images in this message:',
      ...images.map(
        (attachment, index) => `- [Image ${index + 1}] ${attachment.name}`
      ),
    ].join('\n'),
    images,
  };
}

export function extractManagerMessagePlainText(raw: string): string {
  const textWithImageLabels = replaceManagerMessageImages(
    raw,
    ({ attachment, altText }) =>
      `[image: ${attachmentLabel(attachment, altText)}]`
  );
  const normalized = stripMarkdownDecoration(textWithImageLabels)
    .replace(/\s+/g, ' ')
    .trim();
  return normalized;
}

export function summarizeManagerMessage(raw: string, maxLength = 160): string {
  const text = extractManagerMessagePlainText(raw);
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}
