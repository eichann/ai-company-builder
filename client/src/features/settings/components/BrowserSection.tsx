// Settings → 「ブラウザ操作」: the sites the company allowed, each opened in a window of its own where
// the member logs in themselves. Shown only while the member's policy is on with at least one site.
import { useState } from 'react'
import { Button, Card, SectionHeader } from '../../../shared/ui/primitives'
import { BROWSER_WORDS, type BrowserSiteView } from '../../../../shared/browser-operation'
import { clearBrowserLogin, openBrowserSite } from '../api'
import { BrowserPcSection } from './BrowserPcSection'
import { BrowserRecordingSection } from './BrowserRecordingSection'
import { BrowserToolsetSection } from './BrowserToolsetSection'

export function BrowserSection({ companyId, sites }: { companyId: string; sites: BrowserSiteView[] }) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ host: string; text: string } | null>(null)

  const act = async (host: string, action: 'open' | 'clear') => {
    setBusy(true)
    setMessage(null)
    try {
      const r = action === 'open' ? await openBrowserSite(companyId, host) : await clearBrowserLogin(companyId, host)
      if (!r.ok) setMessage({ host, text: r.message })
      else if (action === 'clear') setMessage({ host, text: BROWSER_WORDS.cleared })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-5 px-8 pb-8 pt-7">
      <SectionHeader title={BROWSER_WORDS.section} description={BROWSER_WORDS.intro} />
      {sites.length === 0 && <p className="text-body text-zinc-500 dark:text-zinc-400">{BROWSER_WORDS.none}</p>}
      <Card className="divide-y divide-zinc-100 p-0 dark:divide-white/[0.06]">
        {sites.map(site => (
          <div key={site.host} className="space-y-2 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="font-mono text-body text-zinc-900 dark:text-zinc-100">{site.host}</p>
              <div className="flex gap-2">
                <Button size="sm" variant="primary" disabled={busy} onClick={() => void act(site.host, 'open')}>{BROWSER_WORDS.open}</Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(site.host, 'clear')}>{BROWSER_WORDS.clearLogin}</Button>
              </div>
            </div>
            <p className="text-small text-zinc-500 dark:text-zinc-400">
              {site.kept ? BROWSER_WORDS.loginKept : site.notKeptBySandbox ? BROWSER_WORDS.loginNotKeptBySandbox : BROWSER_WORDS.loginNotKept}
            </p>
            {message?.host === site.host && <p role="status" className="text-small text-zinc-600 dark:text-zinc-300">{message.text}</p>}
          </div>
        ))}
      </Card>
      {sites.length > 0 && <BrowserRecordingSection companyId={companyId} sites={sites} />}
      <BrowserPcSection companyId={companyId} />
      {sites.length > 0 && <BrowserToolsetSection />}
    </div>
  )
}
