import { describe, expect, it } from 'vitest';
import {
  buildManagerMessagePromptContent,
  extractManagerMessagePlainText,
  parseManagerMessage,
  serializeManagerMessage,
} from '../manager-message.js';

describe('manager-message helpers', () => {
  it('serializes and parses multiline rich messages with referenced attachments only', () => {
    const serialized = serializeManagerMessage({
      content: '1行目\n\n![capture](attachment://img-1)\n\n3行目',
      attachments: [
        {
          id: 'img-1',
          name: 'capture.png',
          mimeType: 'image/png',
          dataUrl: 'data:image/png;base64,AAAA',
        },
        {
          id: 'img-unused',
          name: 'unused.png',
          mimeType: 'image/png',
          dataUrl: 'data:image/png;base64,BBBB',
        },
      ],
    });

    const parsed = parseManagerMessage(serialized);

    expect(parsed.markdown).toBe(
      '1行目\n\n![capture](attachment://img-1)\n\n3行目'
    );
    expect(parsed.attachments).toEqual([
      {
        id: 'img-1',
        name: 'capture.png',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,AAAA',
      },
    ]);
  });

  it('builds prompt text and preview text without leaking inline metadata blobs', () => {
    const richMessage = serializeManagerMessage({
      content: '最初の説明\n\n![設計図](attachment://img-1)\n\n最後の説明',
      attachments: [
        {
          id: 'img-1',
          name: 'diagram.png',
          mimeType: 'image/png',
          dataUrl: 'data:image/png;base64,AAAA',
        },
      ],
    });

    expect(extractManagerMessagePlainText(richMessage)).toBe(
      '最初の説明 [image: 設計図] 最後の説明'
    );

    expect(buildManagerMessagePromptContent(richMessage)).toEqual({
      text: [
        '最初の説明',
        '',
        '[Image 1: 設計図]',
        '',
        '最後の説明',
        '',
        'Attached images in this message:',
        '- [Image 1] diagram.png',
      ].join('\n'),
      images: [
        {
          id: 'img-1',
          name: 'diagram.png',
          mimeType: 'image/png',
          dataUrl: 'data:image/png;base64,AAAA',
        },
      ],
    });
  });
});
