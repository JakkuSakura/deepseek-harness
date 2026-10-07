/**
 * Which changes are pictures.
 *
 * A diff of an image is the sentence "Binary files differ", which tells a reader
 * nothing they did not already know from the row. These paths are drawn instead.
 *
 * The test is the extension, not the content: reading bytes to decide would mean a
 * read per changed path on every poll. An extension is what a reader recognises the
 * file by anyway, and a wrong guess is not fatal — the text diff still renders, and
 * `git` itself decides binary-ness by content when it writes the diff, so the two
 * can only disagree about a file that claims an image extension with no picture in
 * it.
 */

/** Extensions drawn as pictures, without the dot. */
export const IMAGE_EXTENSIONS: readonly string[] = [
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico',
]

/**
 * Whether one path is drawn as a picture.
 * @param path - the workspace-relative path.
 * @returns true when the path's extension is one of {@link IMAGE_EXTENSIONS}.
 */
export function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf('.')
  // A leading dot names a hidden file, not an extension: `.png` is a file called
  // `.png`.
  if (dot <= 0) return false
  return IMAGE_EXTENSIONS.includes(path.slice(dot + 1).toLowerCase())
}
