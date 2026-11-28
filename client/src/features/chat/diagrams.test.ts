import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DIAGRAM_MAX_CHARS, MERMAID_MAX_CHARS, diagramOf, mermaidWithoutConfig } from './diagrams'

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'

// A code example the member asked for must stay code: only a block that is one whole picture is drawn.
test('only ```mermaid and a block that is one whole <svg> are drawn; HTML, partial SVG and other code stay code', () => {
  assert.equal(diagramOf('mermaid', 'graph TD; A-->B')?.kind, 'mermaid')
  assert.equal(diagramOf('Mermaid', 'graph TD; A-->B')?.kind, 'mermaid')
  for (const lang of ['svg', 'xml', undefined]) assert.equal(diagramOf(lang, SVG)?.kind, 'svg', String(lang))
  assert.equal(diagramOf('svg', `<?xml version="1.0"?>\n<!-- 図 -->\n${SVG}\n`)?.kind, 'svg')
  assert.equal(diagramOf('html', SVG), null)
  assert.equal(diagramOf('html', `<div>${SVG}</div>`), null)
  assert.equal(diagramOf('svg', `${SVG}<script>x()</script>`), null)
  assert.equal(diagramOf(undefined, `説明\n${SVG}`), null)
  assert.equal(diagramOf('ts', 'const a = 1'), null)
  assert.equal(diagramOf('mermaid', '   \n'), null)
})

// mermaid lays out on the page's thread: a huge one would freeze the app.
test('a block too large to be worth drawing stays code', () => {
  assert.equal(diagramOf('mermaid', `graph TD\n${'A-->B\n'.repeat(MERMAID_MAX_CHARS / 6 + 1)}`), null)
  assert.equal(diagramOf('svg', `<svg>${'<g/>'.repeat(DIAGRAM_MAX_CHARS / 4)}</svg>`), null)
})

// mermaid's own settings in the text could ask for 'loose' security or HTML labels: they never reach mermaid.
test('a diagram cannot change how mermaid is set up: init directives and front matter are taken out', () => {
  const text = '---\nconfig:\n  securityLevel: loose\n---\n%%{init: {"securityLevel": "loose", "htmlLabels": true}}%%\ngraph TD\n  A-->B\n  %%{ init: { "theme": "x" } }%%\n  %% a comment stays\n'
  const cleaned = mermaidWithoutConfig(text)
  assert.doesNotMatch(cleaned, /securityLevel|htmlLabels|init/)
  assert.match(cleaned, /graph TD\n {2}A-->B/)
  assert.match(cleaned, /%% a comment stays/)
  // Slipped-in spellings: spaces after the front matter's dashes, a directive rebuilt by taking another out.
  assert.doesNotMatch(mermaidWithoutConfig('---  \nconfig:\n  securityLevel: loose\n---\ngraph TD\n  A-->B'), /securityLevel/)
  assert.doesNotMatch(mermaidWithoutConfig('%%%%{x}%%{init: {"securityLevel": "loose"}}%%\ngraph TD'), /init|securityLevel/)
})
