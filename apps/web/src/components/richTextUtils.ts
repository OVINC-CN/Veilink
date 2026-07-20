import type { RichNode, RichTextDocument } from '../models'

export function extractLinks(document: RichTextDocument): string[] {
  const links = new Set<string>()
  const visit = (node: RichNode): void => {
    for (const mark of node.marks ?? []) {
      if (mark.type === 'link' && mark.attrs?.href && links.size < 10) links.add(mark.attrs.href)
    }
    node.content?.forEach(visit)
  }
  visit(document)
  return [...links]
}

export function prepareDocumentForWire(document: RichTextDocument): RichTextDocument {
  const visit = (node: RichNode): RichNode => {
    const next: RichNode = { ...node }
    if (node.type === 'mention') {
      next.attrs = { id: node.attrs?.id, label: node.attrs?.label }
    } else if (node.attrs) {
      next.attrs = { ...node.attrs }
    }
    if (node.content) next.content = node.content.map(visit)
    return next
  }
  return visit(document) as RichTextDocument
}
