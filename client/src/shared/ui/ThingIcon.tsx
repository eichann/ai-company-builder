// ACB foundation: tasks, records, search, notifications and the editor's record tabs show the same
// icon for a kind of thing (言葉の決まり 2.: the same icon everywhere), so it cannot live in one feature.
import type { Icon } from '@phosphor-icons/react'
import {
  ArrowBendUpLeft, Briefcase, Buildings, CalendarBlank, ChatCircleDots, ChatTeardropText, CheckSquare, ClipboardText,
  Envelope, Eye, FileText, FilmSlate, GoogleDriveLogo, Lightning, LockSimple, PaperPlaneRight, PaperPlaneTilt, Robot,
  Scales, SealCheck, SlackLogo, Stamp, Target, UserCircle, UsersThree, VideoCamera,
} from '@phosphor-icons/react'
import { bundleLook, ONLY_YOU, thingKindOf, thingName, THING_NAMES, type ThingKind } from '../../../shared/thing-words'

const LOOKS: Record<Exclude<ThingKind, 'bundle'>, { icon: Icon; color: string }> = {
  task: { icon: CheckSquare, color: 'text-accent' },
  minutes_check: { icon: ClipboardText, color: 'text-accent' },
  meeting: { icon: UsersThree, color: 'text-sky-600 dark:text-sky-400' },
  decision: { icon: Scales, color: 'text-amber-600 dark:text-amber-400' },
  incoming: { icon: ChatTeardropText, color: 'text-teal-600 dark:text-teal-400' },
  outbound: { icon: PaperPlaneTilt, color: 'text-rose-500' },
  sent: { icon: PaperPlaneRight, color: 'text-emerald-600 dark:text-emerald-400' },
  approval: { icon: Stamp, color: 'text-orange-600 dark:text-orange-400' },
  reply_request: { icon: ArrowBendUpLeft, color: 'text-violet-600 dark:text-violet-400' },
  consultation: { icon: ChatCircleDots, color: 'text-accent' },
  skill: { icon: Lightning, color: 'text-amber-500' },
  counterpart: { icon: Buildings, color: 'text-slate-600 dark:text-slate-300' },
  file: { icon: FileText, color: 'text-gray-500' },
  other: { icon: FileText, color: 'text-gray-500' },
}
const BUNDLE_ICONS = { deal: Briefcase, program: FilmSlate, project: Target } as const

interface Props {
  kind: ThingKind
  /** A bundle's type label (案件, 番組, プロジェクト): picks its picture. */
  typeLabel?: string | null
  size?: number
  className?: string
  /** Read out instead of the kind's name (a bundle's own label). */
  label?: string
}

/** One kind of thing, one icon: tabs, list rows, links, search, 「あなたの番」. */
export function ThingIcon({ kind, typeLabel, size = 14, className = '', label }: Props) {
  const look = kind === 'bundle'
    ? { icon: BUNDLE_ICONS[bundleLook(typeLabel)], color: 'text-indigo-600 dark:text-indigo-400' }
    : LOOKS[kind]
  const I = look.icon
  const name = label ?? (kind === 'bundle' || kind === 'other' ? (typeLabel ?? '') : THING_NAMES[kind])
  return <I size={size} weight="duotone" className={`shrink-0 ${look.color} ${className}`} aria-label={name || undefined} aria-hidden={name ? undefined : true} />
}

/** A record's icon from its type (the same rule as its name: `thingName`). */
export function RecordIcon({ record, size, className }: { record: Parameters<typeof thingName>[0]; size?: number; className?: string }) {
  const name = thingName(record)
  return <ThingIcon kind={thingKindOf(record)} typeLabel={record.typeLabel} label={name} size={size} className={className} />
}

/** Where a thing came from: the outside service's mark, always next to 「どこから来たか」 (7.). */
export type ThingSource = 'calendar' | 'drive' | 'gmail' | 'slack' | 'meet' | 'ai' | 'person' | 'acb'
const SOURCE_NAMES: Record<ThingSource, string> = {
  calendar: 'Google カレンダー', drive: 'Google ドライブ', gmail: 'Gmail', slack: 'Slack', meet: 'Google Meet', ai: 'AI', person: '人', acb: 'ACB',
}
const SOURCE_LOOKS: Record<ThingSource, { icon: Icon; color: string }> = {
  calendar: { icon: CalendarBlank, color: 'text-sky-500' },
  drive: { icon: GoogleDriveLogo, color: 'text-emerald-500' },
  gmail: { icon: Envelope, color: 'text-rose-500' },
  slack: { icon: SlackLogo, color: 'text-violet-500' },
  meet: { icon: VideoCamera, color: 'text-emerald-600' },
  ai: { icon: Robot, color: 'text-violet-500' },
  person: { icon: UserCircle, color: 'text-gray-400' },
  acb: { icon: SealCheck, color: 'text-accent' },
}
export function SourceIcon({ source, size = 12 }: { source: ThingSource; size?: number }) {
  const { icon: I, color } = SOURCE_LOOKS[source]
  return <I size={size} weight="fill" className={`shrink-0 ${color}`} aria-label={SOURCE_NAMES[source]} />
}

/** Who can see it, in plain words (5b): 「あなただけ」 gets a coloured lock, anything else an eye. */
export function SeenBy({ who, small }: { who: string; small?: boolean }) {
  const only = who === ONLY_YOU
  const I = only ? LockSimple : Eye
  const tone = only ? 'text-amber-700 dark:text-amber-300' : 'text-gray-500 dark:text-zinc-400'
  const pill = small ? 'text-[10px]' : `rounded-full px-2 py-0.5 text-[11px] ${only ? 'bg-amber-500/10' : 'bg-gray-100 dark:bg-zinc-800'}`
  return (
    <span data-seen title={`見られる人：${who}`} className={`inline-flex items-center gap-0.5 whitespace-nowrap ${tone} ${pill}`}>
      <I size={small ? 10 : 11} weight={only ? 'fill' : 'regular'} />{who}
    </span>
  )
}
