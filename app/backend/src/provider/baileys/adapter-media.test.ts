import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createBaileysMessageTransport } from './adapter.js';

/**
 * adapter-media.test.ts (P34 Unit B, ADR 0052 accepted scope) - the
 * `image`/`document` wire-translation shapes `toWaContent` builds, split out
 * of `adapter.test.ts` purely for that file's max-lines cap (same discipline
 * every other split in this repo follows). No real WhatsApp anywhere here -
 * a fake `sendMessage` records the exact content object it was called with.
 */

const INSTANCE_ID = 'inst-1';

describe('createBaileysMessageTransport - image/document content shapes', () => {
  it('an_image_message_builds_exactly_the_stream_and_caption_shape', async () => {
    const sendMessage = vi.fn(() => Promise.resolve({ id: 'wamid.HBg=' }));
    const transport = createBaileysMessageTransport({
      getSendSocket: () => ({ sendMessage }),
    });
    const stream = Readable.from(['fake-jpeg-bytes']);

    await transport.send(INSTANCE_ID, {
      to: '911234567890@s.whatsapp.net',
      kind: 'image',
      stream,
      caption: 'look at this',
    });

    expect(sendMessage).toHaveBeenCalledWith('911234567890@s.whatsapp.net', {
      image: { stream },
      caption: 'look at this',
    });
  });

  it('an_image_message_with_no_caption_omits_the_caption_field', async () => {
    const sendMessage = vi.fn(() => Promise.resolve({ id: 'wamid.HBg=' }));
    const transport = createBaileysMessageTransport({
      getSendSocket: () => ({ sendMessage }),
    });
    const stream = Readable.from(['fake-jpeg-bytes']);

    await transport.send(INSTANCE_ID, {
      to: '911234567890@s.whatsapp.net',
      kind: 'image',
      stream,
    });

    expect(sendMessage).toHaveBeenCalledWith('911234567890@s.whatsapp.net', {
      image: { stream },
    });
  });

  it('a_document_message_builds_exactly_the_stream_mimetype_filename_and_caption_shape', async () => {
    const sendMessage = vi.fn(() => Promise.resolve({ id: 'wamid.HBg=' }));
    const transport = createBaileysMessageTransport({
      getSendSocket: () => ({ sendMessage }),
    });
    const stream = Readable.from(['fake-pdf-bytes']);

    await transport.send(INSTANCE_ID, {
      to: '911234567890@s.whatsapp.net',
      kind: 'document',
      stream,
      mimeType: 'application/pdf',
      fileName: 'invoice.pdf',
      caption: 'here it is',
    });

    expect(sendMessage).toHaveBeenCalledWith('911234567890@s.whatsapp.net', {
      document: { stream },
      mimetype: 'application/pdf',
      fileName: 'invoice.pdf',
      caption: 'here it is',
    });
  });

  it('a_document_message_with_no_caption_omits_the_caption_field', async () => {
    const sendMessage = vi.fn(() => Promise.resolve({ id: 'wamid.HBg=' }));
    const transport = createBaileysMessageTransport({
      getSendSocket: () => ({ sendMessage }),
    });
    const stream = Readable.from(['fake-pdf-bytes']);

    await transport.send(INSTANCE_ID, {
      to: '911234567890@s.whatsapp.net',
      kind: 'document',
      stream,
      mimeType: 'application/pdf',
      fileName: 'invoice.pdf',
    });

    expect(sendMessage).toHaveBeenCalledWith('911234567890@s.whatsapp.net', {
      document: { stream },
      mimetype: 'application/pdf',
      fileName: 'invoice.pdf',
    });
  });
});
