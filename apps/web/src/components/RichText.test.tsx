import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { RichTextDocument } from '../models'
import { LocalLinkCard } from './LocalLinkCard'
import { RichText } from './RichText'
import { extractLinks } from './richTextUtils'

describe('safe local rich-text rendering', () => {
  it('renders message content as text and never creates injected markup', () => {
    const document: RichTextDocument = {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{ type: 'text', text: '<img src=x onerror="alert(1)"><script>alert(2)</script>' }],
      }],
    }
    const { container } = render(<RichText document={document} />)

    expect(screen.getByText(/<img src=x/u)).toBeInTheDocument()
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
  })

  it('allows HTTP(S) links with an isolated new browsing context', () => {
    const document: RichTextDocument = {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{
          type: 'text',
          text: 'Veilink',
          marks: [{ type: 'link', attrs: { href: 'https://example.com/private?q=1' } }],
        }],
      }],
    }
    render(<RichText document={document} />)

    const link = screen.getByRole('link', { name: 'Veilink' })
    expect(link).toHaveAttribute('href', 'https://example.com/private?q=1')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('does not turn executable URL schemes into links', () => {
    const document: RichTextDocument = {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{
          type: 'text',
          text: 'do not run',
          marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
        }],
      }],
    }
    render(<RichText document={document} />)

    expect(screen.getByText('do not run')).toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('extracts no more than ten unique links and rejects unsafe local cards', () => {
    const links = Array.from({ length: 12 }, (_, index) => ({
      type: 'text',
      text: String(index),
      marks: [{ type: 'link' as const, attrs: { href: `https://example.com/${index}` } }],
    }))
    const document: RichTextDocument = {
      type: 'doc',
      content: [{ type: 'paragraph', content: links }],
    }

    expect(extractLinks(document)).toHaveLength(10)
    const { container } = render(<LocalLinkCard href="javascript:alert(1)" />)
    expect(container).toBeEmptyDOMElement()
  })
})
