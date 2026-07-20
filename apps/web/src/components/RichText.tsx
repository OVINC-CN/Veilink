import { Fragment, type ReactNode } from 'react'
import type { RichMark, RichNode, RichTextDocument } from '../models'

function applyMarks(content: ReactNode, marks: RichMark[] | undefined, key: string): ReactNode {
  return (marks ?? []).reduce<ReactNode>((child, mark, index) => {
    const markKey = `${key}-mark-${index}`
    if (mark.type === 'bold') return <strong key={markKey}>{child}</strong>
    if (mark.type === 'italic') return <em key={markKey}>{child}</em>
    if (mark.type === 'strike') return <s key={markKey}>{child}</s>
    if (mark.type === 'code') return <code key={markKey}>{child}</code>
    if (mark.type === 'link' && mark.attrs?.href) {
      try {
        const url = new URL(mark.attrs.href)
        if (url.protocol === 'http:' || url.protocol === 'https:') {
          return <a key={markKey} href={url.href} target="_blank" rel="noopener noreferrer">{child}</a>
        }
      } catch {
        return child
      }
    }
    return <Fragment key={markKey}>{child}</Fragment>
  }, content)
}

function renderNode(node: RichNode, key: string): ReactNode {
  if (node.type === 'text') return applyMarks(node.text ?? '', node.marks, key)
  if (node.type === 'hardBreak') return <br key={key} />
  const children = node.content?.map((child, index) => renderNode(child, `${key}-${index}`)) ?? null

  switch (node.type) {
    case 'paragraph': return <p key={key}>{children}</p>
    case 'heading': {
      const level = Math.min(3, Math.max(1, Number(node.attrs?.level ?? 2)))
      if (level === 1) return <h1 key={key}>{children}</h1>
      if (level === 3) return <h3 key={key}>{children}</h3>
      return <h2 key={key}>{children}</h2>
    }
    case 'bulletList': return <ul key={key}>{children}</ul>
    case 'orderedList': return <ol key={key}>{children}</ol>
    case 'listItem': return <li key={key}>{children}</li>
    case 'blockquote': return <blockquote key={key}>{children}</blockquote>
    case 'codeBlock': return <pre key={key}><code>{children}</code></pre>
    default: return <Fragment key={key}>{children}</Fragment>
  }
}

export function RichText({ document }: { document: RichTextDocument }) {
  return <div className="rich-text">{document.content.map((node, index) => renderNode(node, `node-${index}`))}</div>
}
