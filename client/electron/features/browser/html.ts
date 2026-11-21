// The preview's HTML parser (agent-browser.md "The operator and the preview", design memo §33 2-3):
// a page's text → the neutral tree client/shared/browser-page.ts reads. parse5 is the WHATWG HTML
// parsing algorithm (the one browsers follow), so broken markup is mended the way a browser mends it
// and never read with regular expressions. Nothing is run: the page is only text here.
//
// - Comments are dropped; a `<template>`'s content is not visited (the core skips the element too).
// - An attribute written twice on one start tag is a parse error the parser reports with its place:
//   the element that tag opened is marked (`duplicateAttribute`), and the core never reads it.
import { parse, type DefaultTreeAdapterTypes } from 'parse5'
import { countIds, type BrowserHtmlDocument, type BrowserHtmlElement, type BrowserHtmlNode } from '../../../shared/browser-page'

type Node = DefaultTreeAdapterTypes.Node
type Element = DefaultTreeAdapterTypes.Element

const isElement = (node: Node): node is Element => 'tagName' in node && Array.isArray((node as Element).attrs)

export function parseBrowserHtml(html: string): BrowserHtmlDocument {
  const duplicates: number[] = []
  const document = parse(html, {
    sourceCodeLocationInfo: true,
    onParseError: error => { if (error.code === 'duplicate-attribute') duplicates.push(error.startOffset) },
  })
  let body: BrowserHtmlElement | null = null

  const convert = (el: Element): BrowserHtmlElement => {
    const start = el.sourceCodeLocation?.startTag
    const duplicateAttribute = !!start && duplicates.some(at => at >= start.startOffset && at < start.endOffset)
    const children: BrowserHtmlNode[] = []
    // A template's parts live in its `content`, never in its children: not visited.
    for (const child of el.childNodes ?? []) {
      if (isElement(child)) children.push(convert(child))
      else if (child.nodeName === '#text') children.push({ kind: 'text', text: (child as DefaultTreeAdapterTypes.TextNode).value })
    }
    const out: BrowserHtmlElement = { kind: 'element', tag: el.tagName.toLowerCase(), attrs: el.attrs.map(a => [a.name, a.value] as const), duplicateAttribute, children }
    if (out.tag === 'body' && !body) body = out
    return out
  }

  let root: BrowserHtmlElement | null = null
  for (const child of document.childNodes) if (isElement(child)) root = convert(child)
  return { root, body, idCounts: countIds(root) }
}
