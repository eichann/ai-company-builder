interface MarkdownViewerProps {
  content: string
}

export function MarkdownViewer({ content }: MarkdownViewerProps) {
  // Simple markdown rendering - in production, use a proper markdown library
  const renderMarkdown = (text: string) => {
    const lines = text.split('\n')
    const elements: JSX.Element[] = []
    let inCodeBlock = false
    let codeContent = ''

    lines.forEach((line, index) => {
      if (line.startsWith('```')) {
        if (inCodeBlock) {
          elements.push(
            <pre
              key={index}
              className="bg-black/30 rounded-lg p-4 my-3 overflow-x-auto text-sm font-mono"
            >
              <code>{codeContent.trim()}</code>
            </pre>
          )
          codeContent = ''
          inCodeBlock = false
        } else {
          inCodeBlock = true
        }
        return
      }

      if (inCodeBlock) {
        codeContent += line + '\n'
        return
      }

      // Headers
      if (line.startsWith('# ')) {
        elements.push(
          <h1 key={index} className="text-2xl font-bold mb-4 mt-6 text-text-primary">
            {line.slice(2)}
          </h1>
        )
      } else if (line.startsWith('## ')) {
        elements.push(
          <h2 key={index} className="text-xl font-bold mb-3 mt-5 text-text-primary">
            {line.slice(3)}
          </h2>
        )
      } else if (line.startsWith('### ')) {
        elements.push(
          <h3 key={index} className="text-lg font-bold mb-2 mt-4 text-text-primary">
            {line.slice(4)}
          </h3>
        )
      }
      // List items
      else if (line.startsWith('- ') || line.startsWith('* ')) {
        elements.push(
          <li key={index} className="ml-4 my-1">
            {line.slice(2)}
          </li>
        )
      }
      // Empty lines
      else if (line.trim() === '') {
        elements.push(<div key={index} className="h-2" />)
      }
      // Regular paragraphs
      else {
        elements.push(
          <p key={index} className="my-2 leading-relaxed">
            {line}
          </p>
        )
      }
    })

    return elements
  }

  return (
    <div className="prose prose-invert max-w-none text-text-primary">
      {renderMarkdown(content)}
    </div>
  )
}
