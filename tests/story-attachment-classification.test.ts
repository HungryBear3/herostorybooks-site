import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyStoryAttachment,
  documentMimeForFile,
} from '../src/lib/story-attachment.ts';

const file = (name: string, type: string) => new File(['fixture'], name, { type });

test('audio and document classifications require a coherent MIME and extension pair', () => {
  assert.deepEqual(classifyStoryAttachment(file('memory.mp3', 'audio/mpeg')), {
    kind: 'audio', mimeType: 'audio/mpeg', extension: 'mp3',
  });
  assert.deepEqual(classifyStoryAttachment(file('memory.pdf', 'application/pdf')), {
    kind: 'document', mimeType: 'application/pdf', extension: 'pdf',
  });
  assert.deepEqual(classifyStoryAttachment(file('memory.mp3', 'application/pdf')), { kind: 'invalid' });
  assert.deepEqual(classifyStoryAttachment(file('memory.pdf', 'audio/mpeg')), { kind: 'invalid' });
  assert.deepEqual(classifyStoryAttachment(file('memory.bin', 'application/pdf')), { kind: 'invalid' });
});

test('empty MIME documents derive only an allowlisted canonical MIME from extension', () => {
  assert.equal(documentMimeForFile(file('notes.txt', '')), 'text/plain');
  assert.equal(documentMimeForFile(file('notes.PDF', '')), 'application/pdf');
  assert.equal(documentMimeForFile(file('notes.doc', 'application/octet-stream')), 'application/msword');
  assert.equal(
    documentMimeForFile(file('notes.docx', '')),
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  );
  assert.equal(documentMimeForFile(file('notes.bin', '')), null);
});

test('empty MIME audio keeps the legacy extension-derived lane without accepting unknown files', () => {
  assert.deepEqual(classifyStoryAttachment(file('memo.mp3', '')), {
    kind: 'audio', mimeType: 'audio/mpeg', extension: 'mp3',
  });
  assert.deepEqual(classifyStoryAttachment(file('memo.webm', 'application/octet-stream')), {
    kind: 'audio', mimeType: 'audio/webm', extension: 'webm',
  });
  assert.deepEqual(classifyStoryAttachment(file('memo.bin', '')), { kind: 'invalid' });
});
