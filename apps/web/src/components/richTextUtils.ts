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
