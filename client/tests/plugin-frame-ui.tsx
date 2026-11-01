/* eslint-disable react-refresh/only-export-components -- standalone preview page entry, never hot-reloaded as a module */
// Preview page for a plugin's screen (plugin-frame.md): the real frame and bridge host, with the
// page served from this preview server under /__plugin/ (the spec answers it with the CSP
// `acb-plugin://` gives; Chromium here cannot load the custom scheme). The app's window holds a
// fake electronAPI and a stored value the frame must not reach; what reached "main" is listed.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../src/index.css'
import { PluginFrameView } from '../src/features/plugins/components/PluginFrame'
import { installElectronAPI } from './ui/fixtures/electron-api'

try { localStorage.setItem('acb-secret', 'app-only') } catch { /* storage may be off */ }

let report: (line: string) => void = () => {}
installElectronAPI({
  callPluginBridge: async (companyId, plugin, op, args) => {
    report(`main ${companyId} ${plugin.id}@${plugin.version} ${op} ${JSON.stringify(args)}`)
    return { ok: true, data: { total: 0, records: [] } }
  },
})

function Preview() {
  const [lines, setLines] = useState<string[]>([])
  report = line => setLines(l => [...l, line])
  return (
    <main className="min-h-screen bg-white p-8 text-gray-900">
      <PluginFrameView
        companyId="co-preview"
        plugin={{ id: 'planning', version: '0.1.0' }}
        entry="ui/index.html"
        title="番組"
        src="/__plugin/planning/0.1.0/ui/index.html"
        className="h-64 w-full border"
        onOpen={target => { report(`open ${JSON.stringify(target)}`); return { ok: true, data: null } }}
      />
      <ul aria-label="本体が受け取ったもの">{lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)
