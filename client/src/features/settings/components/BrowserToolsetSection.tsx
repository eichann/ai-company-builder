// Settings › 「ブラウザ操作」 › 「係の道具」 (agent-browser.md "The operator's tool sets"): this PC's choice of how the
// operator AI's tools are described to it — いまの形 (default), まとめた形, or a known tool set's words (Playwright /
// OpenAI / Anthropic 風). What it may do and every guard stay the same.
import { Callout, Card } from '../../../shared/ui/primitives'
import { BROWSER_OPERATOR_TOOLSETS, BROWSER_TOOLSET_WORDS as W } from '../../../../shared/browser-operator-toolsets'
import { useBrowserToolset } from '../hooks/useBrowserToolset'

export function BrowserToolsetSection() {
  const { loadRef, toolset, failed, choose } = useBrowserToolset()
  return (
    <section ref={loadRef} aria-label={W.heading} data-browser-toolset>
      <Card className="space-y-3 p-5">
        <p className="font-strong text-body text-text">{W.heading}</p>
        <p className="text-small text-text-muted">{W.intro}</p>
        <fieldset className="space-y-2" disabled={toolset === null}>
          <legend className="sr-only">{W.heading}</legend>
          {BROWSER_OPERATOR_TOOLSETS.map(set => (
            <label key={set} className="flex items-start gap-2 text-body text-text">
              <input type="radio" name="browser-toolset" className="mt-1" checked={toolset === set} onChange={() => void choose(set)} />
              <span>
                <span className="font-strong">{W.names[set]}</span>
                <span className="block text-small text-text-muted">{W.details[set]}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {failed && <Callout tone="danger">{W.failed}</Callout>}
      </Card>
    </section>
  )
}
