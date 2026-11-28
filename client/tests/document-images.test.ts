// The one rule for a document's images (client/shared/document-images.ts, files-and-editor.md "Images in a
// document"): what is taken in is decided by the bytes (no SVG, no HTML however it is named), names never collide
// within a second, and the AI is told the same place and shape a paste gets.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  documentImageFileRefusal, documentImageInstruction, documentImageKind, documentImageMarkdown, documentImageName,
  documentImageRefusal, MAX_DOCUMENT_IMAGE_SIZE,
} from '../shared/document-images'
import { LARGE_FILE_THRESHOLD } from '../shared/large-file-limit'
import { MAX_DROP_FILE_SIZE } from '../shared/file-drop'

const bytes = (...b: number[]) => new Uint8Array(b)
const text = (s: string) => new TextEncoder().encode(s)

test('the kind comes from the bytes: PNG, JPEG, GIF, WebP; SVG, HTML, a renamed text or too few bytes are none', () => {
  assert.equal(documentImageKind(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0)), 'png')
  assert.equal(documentImageKind(bytes(0xff, 0xd8, 0xff, 0xdb)), 'jpg')
  assert.equal(documentImageKind(text('GIF89a……')), 'gif')
  assert.equal(documentImageKind(text('GIF87a')), 'gif')
  assert.equal(documentImageKind(new Uint8Array([...text('RIFF'), 0, 0, 0, 0, ...text('WEBPVP8 ')])), 'webp')
  for (const other of [text('<svg xmlns="http://www.w3.org/2000/svg"/>'), text('<?xml version="1.0"?><svg/>'), text('<html><script>'),
    text('RIFF\0\0\0\0WAVE'), text('GIF8'), bytes(0x89, 0x50, 0x4e, 0x47), bytes()]) {
    assert.equal(documentImageKind(other), null, new TextDecoder().decode(other))
    assert.ok(documentImageRefusal(other), 'refused')
  }
})

test('the size limit is a Finder drop\'s (20 MB), so a pasted image never reaches sync\'s 100 MB limit', () => {
  assert.equal(MAX_DOCUMENT_IMAGE_SIZE, MAX_DROP_FILE_SIZE)
  assert.ok(MAX_DOCUMENT_IMAGE_SIZE < LARGE_FILE_THRESHOLD)
  const png = new Uint8Array(MAX_DOCUMENT_IMAGE_SIZE + 1)
  png.set(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
  assert.equal(documentImageRefusal(png), '画像が20MBを超えています')
  assert.equal(documentImageRefusal(png.subarray(0, MAX_DOCUMENT_IMAGE_SIZE)), null)
  // The screen's check before reading a file: the same limit and kinds by the file's type.
  assert.equal(documentImageFileRefusal({ type: 'image/png', size: MAX_DOCUMENT_IMAGE_SIZE }), null)
  assert.equal(documentImageFileRefusal({ type: 'image/png', size: MAX_DOCUMENT_IMAGE_SIZE + 1 }), '画像が20MBを超えています')
  for (const type of ['image/svg+xml', 'text/html', 'application/pdf', '']) {
    assert.equal(documentImageFileRefusal({ type, size: 10 }), '入れられるのは PNG・JPEG・GIF・WebP の画像だけです', type)
  }
})

test('names: the local date and time to the second, then -2, -3 for the same second; the line is ![](images/<name>)', () => {
  const at = new Date(2026, 0, 5, 9, 3, 7)
  assert.equal(documentImageName(at, 'png'), '20260105-090307.png')
  assert.equal(documentImageName(at, 'jpg', 1), '20260105-090307-2.jpg')
  assert.equal(documentImageName(at, 'webp', 2), '20260105-090307-3.webp')
  assert.equal(documentImageMarkdown(documentImageName(at, 'gif')), '![](images/20260105-090307.gif)')
  // The AI's line is written from the same functions.
  assert.ok(documentImageInstruction().includes(documentImageMarkdown(documentImageName(new Date(2026, 10, 29, 14, 30, 5), 'png'))))
  assert.equal(documentImageInstruction().split('\n').length, 1, 'one line')
})
