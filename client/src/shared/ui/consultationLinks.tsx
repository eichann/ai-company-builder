// ACB foundation: the 「AIへの相談」 group of a record's 「つながっているもの」, used by the records and
// tasks features' cards (the screen hands both the same consultations and 「相談する」).
import { ChatCircleDots, Plus } from '@phosphor-icons/react'
import { runCommand } from '../commands/commands'
import type { LinkedGroupExtra, LinkedRow } from './LinkedColumn'

/** One consultation whose main topic is the record (this PC's history). */
export interface LinkedConsultation { sessionId: string; title: string; updatedAt: string }

const NAME = 'AIへの相談'

function when(at: string): string {
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** Its rows (each opens in the chat) and the group's ［相談する］［＋新しい相談］. */
export function consultationLinks(consultations: readonly LinkedConsultation[], onConsult?: (fresh: boolean) => void): { rows: LinkedRow[]; extra: LinkedGroupExtra | null } {
  const rows: LinkedRow[] = consultations.map(c => ({
    key: `consultation:${c.sessionId}`, name: NAME, kind: 'consultation', label: c.title, sub: when(c.updatedAt),
    onOpen: () => { void runCommand('chat.openConsultation', { sessionId: c.sessionId }).catch(() => {}) },
  }))
  if (!onConsult) return { rows, extra: null }
  return {
    rows,
    extra: {
      name: NAME, kind: 'consultation',
      action: (
        <div className="flex items-center gap-1 pt-0.5">
          <button type="button" onClick={() => onConsult(false)} title="いちばん最近の相談を開きます（なければ新しく始めます）"
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11.5px] font-medium text-accent hover:bg-accent/10"><ChatCircleDots size={13} />相談する</button>
          <button type="button" onClick={() => onConsult(true)}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11.5px] text-gray-500 hover:bg-gray-100 hover:text-accent dark:text-zinc-400 dark:hover:bg-zinc-800"><Plus size={10} />新しい相談</button>
        </div>
      ),
    },
  }
}
