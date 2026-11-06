// 「新しい〇〇にする」 (新しい画面のデモ J): the name filled in from the meeting or the 連絡, the 相手 from
// its participants, 「この会議の宿題（n）も入れる」 on at first, and similar ones offered before making
// another (［そちらにつなぐ］).
import { useState } from 'react'
import { Warning, X } from '@phosphor-icons/react'
import type { BundleChoice } from '../../../../shared/tasks'
import { MAIN_BUTTON, SMALL_BUTTON } from '../../../shared/ui/RecordPage'
import { useBundleChoices } from '../hooks/useBundleChoices'
import { similarBundles } from '../similarBundles'
import { mayMakePrivateBundle, type BundlePlace } from '../model'

const FIELD = 'w-full rounded-md border border-gray-200 bg-white px-2 py-1 text-[13px] dark:border-zinc-700 dark:bg-zinc-900'

export interface NewBundleSource {
  /** The name to start from (the meeting's or the 連絡's title) and where it came from. */
  title: string
  titleNote: string
  /** The 相手 it gets, when known (the meeting's 相手). */
  counterpart: { id: string; title: string } | null
  /** The meeting's 宿題 (tasks made from it) that can be put into the new one. */
  homework: number
}

/** Where a new one may go and where it goes unless the member changes it (the creator's own department). */
export interface NewBundlePlaces {
  choices: BundlePlace[]
  defaultFolder: string | null
}

export function NewBundleDialog({ companyId, word, source, places, privateRights, onCreate, onPick, onClose }: {
  companyId: string
  word: string
  source: NewBundleSource
  /** 「〇〇部の案件」 and ［変える］; absent = the department on screen, as the caller decides. */
  places?: NewBundlePlaces
  /**
   * 「公開（会社のみんな）」／「非公開（参加者だけ）」: the member's private-folder rights (undefined while read,
   * null = not known). Absent = no choice offered.
   */
  privateRights?: { role: string; managedDepartmentIds: readonly string[] } | null
  /** null = made and linked; else the reason in words. `place`: the department chosen (with `places`). */
  onCreate: (title: string, withHomework: boolean, place: BundlePlace | null, isPrivate: boolean) => Promise<string | null>
  /** ［そちらにつなぐ］: link the similar one instead. */
  onPick: (bundle: BundleChoice) => Promise<string | null>
  onClose: () => void
}) {
  const choices = useBundleChoices(companyId)
  const [title, setTitle] = useState(source.title)
  const [withHomework, setWithHomework] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [folder, setFolder] = useState<string | null>(places?.defaultFolder ?? null)
  const [changing, setChanging] = useState(false)
  const place = places ? places.choices.find(c => c.folder === folder) ?? places.choices[0] ?? null : null
  const [wantsPrivate, setWantsPrivate] = useState(false)
  const kindWord = place?.kind?.name ?? word
  // Offered wherever the department can be chosen (the window of a task, a meeting or a 来た連絡).
  const offersPrivate = places !== undefined
  const privateAllowed = !!place && !!privateRights && mayMakePrivateBundle(place, privateRights)
  const isPrivate = wantsPrivate && privateAllowed
  const similar = choices?.success ? similarBundles(title, choices.bundles) : []
  const run = async (fn: () => Promise<string | null>) => {
    setBusy(true)
    const failure = await fn()
    setBusy(false)
    if (failure) setError(failure)
    else onClose()
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div role="dialog" aria-label={`新しい${word}にする`} onKeyDown={e => { if (e.key === 'Escape') onClose() }}
        className="w-[460px] space-y-3 rounded-xl bg-white p-4 text-[13px] text-gray-800 shadow-2xl dark:bg-zinc-800 dark:text-zinc-100">
        <div className="flex items-center"><span className="flex-1 text-[14px] font-semibold">新しい{word}にする</span>
          <button type="button" onClick={onClose} aria-label="閉じる" className="rounded p-0.5 hover:bg-gray-100 dark:hover:bg-zinc-700"><X size={12} /></button></div>
        {similar.length > 0 && (
          <div role="group" aria-label={`似た${word}`} className="space-y-1 rounded-lg bg-amber-500/[0.08] px-2.5 py-2 text-[12px]">
            <p className="flex items-center gap-1.5"><Warning size={13} weight="fill" className="shrink-0 text-amber-500" />似た{word}があります。新しく作らずに、そちらにつなぐこともできます。</p>
            {similar.map(b => (
              <div key={b.id} className="flex items-center gap-2 pl-5">
                <span className="min-w-0 flex-1 truncate">「{b.title}」</span>
                <button type="button" disabled={busy} onClick={() => void run(() => onPick(b))} className={SMALL_BUTTON}>そちらにつなぐ</button>
              </div>
            ))}
          </div>
        )}
        <label className="block text-[12px]"><span className="text-gray-500">名前</span>
          <input aria-label="名前" value={title} onChange={e => setTitle(e.target.value)} className={FIELD} />
          <span className="text-[10.5px] text-gray-400">{source.titleNote}</span></label>
        {place && (
          <div className="text-[12px]"><span className="text-gray-500">どこの{word}</span>
            {changing
              ? <select aria-label="部署" value={place.folder ?? ''} onChange={e => { setFolder(e.target.value || null); setChanging(false) }} className={FIELD}>
                {places!.choices.map(c => <option key={c.folder ?? ''} value={c.folder ?? ''}>{c.name}の{c.kind?.name ?? word}</option>)}
              </select>
              : <p className="flex items-center gap-2 py-1 text-[13px]">{place.name}の{place.kind?.name ?? word}
                {places!.choices.length > 1 && <button type="button" onClick={() => setChanging(true)} className={SMALL_BUTTON}>変える</button>}</p>}
          </div>
        )}
        {offersPrivate && place && (
          <div role="radiogroup" aria-label="見られる人" className="space-y-1 text-[12.5px]"><span className="text-[12px] text-gray-500">見られる人</span>
            <label className="flex items-center gap-2"><input type="radio" name="bundle-visibility" checked={!isPrivate} onChange={() => setWantsPrivate(false)} />公開（会社のみんな）</label>
            <label className={`flex items-center gap-2 ${privateAllowed ? '' : 'text-gray-400'}`}>
              <input type="radio" name="bundle-visibility" checked={isPrivate} disabled={!privateAllowed} onChange={() => setWantsPrivate(true)} />非公開（参加者だけ）
            </label>
            {privateRights === undefined
              ? <p className="pl-5 text-[11px] text-gray-400">確かめています…</p>
              : !privateAllowed && <p className="pl-5 text-[11px] text-gray-500">非公開の{kindWord}は、部署の管理役か管理者に作ってもらってください</p>}
            {isPrivate && <p className="pl-5 text-[11px] text-gray-500">あなたと部署の管理役が参加者になります。ほかの人は、作ったあと{kindWord}の画面で足せます。</p>}
          </div>
        )}
        <div className="text-[12px]"><span className="text-gray-500">相手</span>
          <p className="py-1 text-[13px]">{source.counterpart?.title ?? <span className="text-gray-400">なし</span>}</p>
          {source.counterpart && <span className="text-[10.5px] text-gray-400">参加者から入れました</span>}</div>
        {source.homework > 0 && (
          <label className="flex items-center gap-2 text-[12.5px]">
            <input type="checkbox" checked={withHomework} onChange={e => setWithHomework(e.target.checked)} />この会議の宿題（{source.homework}）も入れる
          </label>
        )}
        {error && <p role="alert" className="text-[12px] text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={SMALL_BUTTON}>やめておく</button>
          <button type="button" disabled={busy || !title.trim()} onClick={() => void run(() => onCreate(title.trim(), withHomework && source.homework > 0, place, isPrivate))} className={MAIN_BUTTON}>作る</button>
        </div>
      </div>
    </div>
  )
}
