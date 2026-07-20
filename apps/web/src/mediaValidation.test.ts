// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { validateMedia } from './mediaValidation'

describe('attachment media validation', () => {
  it('never previews active text disguised as an image', async () => {
    const svg = new TextEncoder().encode('\uFEFF  <?xml version="1.0"?><svg onload="alert(1)"></svg>')
    await expect(validateMedia(svg, 'image/png')).resolves.toEqual({
      mime: 'application/octet-stream',
      previewable: false,
    })
  })

  it('requires detected magic bytes before enabling a preview', async () => {
    const arbitrary = new TextEncoder().encode('not really a png')
    await expect(validateMedia(arbitrary, 'image/png')).resolves.toEqual({
      mime: 'image/png',
      previewable: false,
    })
  })
})
