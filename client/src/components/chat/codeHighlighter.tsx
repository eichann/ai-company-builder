import React from 'react'
import PrismLightRaw from 'react-syntax-highlighter/dist/esm/prism-light'
import oneLight from 'react-syntax-highlighter/dist/esm/styles/prism/one-light'
import oneDark from 'react-syntax-highlighter/dist/esm/styles/prism/one-dark'
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash'
import c from 'react-syntax-highlighter/dist/esm/languages/prism/c'
import cpp from 'react-syntax-highlighter/dist/esm/languages/prism/cpp'
import csharp from 'react-syntax-highlighter/dist/esm/languages/prism/csharp'
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css'
import diff from 'react-syntax-highlighter/dist/esm/languages/prism/diff'
import docker from 'react-syntax-highlighter/dist/esm/languages/prism/docker'
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go'
import graphql from 'react-syntax-highlighter/dist/esm/languages/prism/graphql'
import ini from 'react-syntax-highlighter/dist/esm/languages/prism/ini'
import java from 'react-syntax-highlighter/dist/esm/languages/prism/java'
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript'
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json'
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx'
import kotlin from 'react-syntax-highlighter/dist/esm/languages/prism/kotlin'
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown'
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup'
import php from 'react-syntax-highlighter/dist/esm/languages/prism/php'
import powershell from 'react-syntax-highlighter/dist/esm/languages/prism/powershell'
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python'
import ruby from 'react-syntax-highlighter/dist/esm/languages/prism/ruby'
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust'
import scss from 'react-syntax-highlighter/dist/esm/languages/prism/scss'
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql'
import swift from 'react-syntax-highlighter/dist/esm/languages/prism/swift'
import toml from 'react-syntax-highlighter/dist/esm/languages/prism/toml'
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx'
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript'
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml'

// PrismLight with the languages members actually paste, instead of the full
// Prism build (refractor with all ~300 languages, ~2.7 MB in the renderer
// bundle). A language not listed here renders as plain text.
const LANGUAGES = {
  bash, c, cpp, csharp, css, diff, docker, go, graphql, ini, java, javascript, json, jsx, kotlin,
  markdown, markup, php, powershell, python, ruby, rust, scss, sql, swift, toml, tsx, typescript, yaml,
}
for (const [name, language] of Object.entries(LANGUAGES)) PrismLightRaw.registerLanguage(name, language)
// Fence names that are not refractor aliases already (ts, js, py, sh, html, xml, yml, md… are).
PrismLightRaw.alias({ bash: ['zsh', 'console', 'terminal'], markup: ['vue', 'svelte'], json: ['jsonc'], docker: ['Dockerfile'] })

// react-syntax-highlighter ships types compatible with older React. Cast for React 19 JSX compatibility.
const PrismLight = PrismLightRaw as unknown as React.FC<{
  language?: string
  style: Record<string, React.CSSProperties>
  PreTag?: string
  customStyle?: React.CSSProperties
  children: string
}>

const CUSTOM_STYLE: React.CSSProperties = {
  margin: 0,
  borderRadius: '0.5rem',
  fontSize: '12.5px',
  lineHeight: '1.5',
  padding: '0.75rem 1rem',
}

/** A code block still being streamed: the highlighted block's box, without highlighting. */
export function PlainCodeBlock({ isDark, children }: { isDark: boolean; children: string }) {
  const theme = (isDark ? oneDark : oneLight) as Record<string, React.CSSProperties>
  const style = { ...(theme['pre[class*="language-"]'] ?? {}), ...CUSTOM_STYLE, overflow: 'auto' }
  return <div style={style}><code className="font-mono whitespace-pre">{children}</code></div>
}

export function CodeHighlighter({ isDark, language, children }: { isDark: boolean; language: string; children: string }) {
  return (
    <PrismLight
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      style={(isDark ? oneDark : oneLight) as any}
      language={language}
      PreTag="div"
      customStyle={CUSTOM_STYLE}
    >
      {children}
    </PrismLight>
  )
}
