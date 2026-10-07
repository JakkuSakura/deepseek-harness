/**
 * Which paths are drawn as pictures.
 *
 * The rule is an extension test, so it is worth pinning: it decides whether a
 * reader sees the picture or the sentence "Binary files differ".
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { IMAGE_EXTENSIONS, isImagePath } from '../lib/testing/client-image.js'

test('the formats a diff cannot show as text are pictures', () => {
  for (const extension of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico']) {
    assert.equal(isImagePath(`assets/logo.${extension}`), true, extension)
    assert.ok(IMAGE_EXTENSIONS.includes(extension))
  }
})

test('the extension is read in any case and at any depth', () => {
  assert.equal(isImagePath('a/b/c/Photo.PNG'), true)
  assert.equal(isImagePath('icon.JpEg'), true)
})

test('a path that is not a picture is not drawn as one', () => {
  assert.equal(isImagePath('src/index.ts'), false)
  assert.equal(isImagePath('README'), false)
  assert.equal(isImagePath('archive.png.zip'), false)
  assert.equal(isImagePath(''), false)
  // SVG is a picture, and it is also text: it diffs, so it is not in the list.
  assert.equal(isImagePath('diagram.svg'), false)
})

test('a leading dot is not an extension', () => {
  assert.equal(isImagePath('.png'), false)
})
