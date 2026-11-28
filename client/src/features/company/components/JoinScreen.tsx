// 「〇〇 に参加します」 (UX review 20, owner decisions 2026-11-28): the one screen a member confirms
// before anything is put on this PC — the company, the departments for this PC and the place,
// with one ［始める］. The place is decided automatically; 「置き場所を変えたいとき（任意）」 is for
// those who want another one. A place main refused says why here, and ［始める］ waits.
import { useState } from 'react'
import { Buildings, CheckCircle, FolderOpen, FolderPlus, SpinnerGap } from '@phosphor-icons/react'
import type { CompanyInfo } from '../../../../shared/ipc-contract'
import { WORKING_FOLDER_BACKUP_NOTE, WORKING_FOLDER_NOTE } from '../../../../shared/company-folder'
import { chosenDepartmentNames, joinStart, type DepartmentChoice, type PlaceCheck } from '../model'
import { ErrorNotice } from './SelectorParts'

export interface JoinPlace {
  /** The company folder on this PC. */
  path: string
  /** Decided automatically (`~/AI Company Builder/<会社名>`), not picked. */
  automatic: boolean
}

export function JoinScreen({ company, host, place, check, choice, error, busy, onChangeDepartments, onChangePlace, onStart, onBack }: {
  company: CompanyInfo
  /** The company server's host (the same the sign-in showed). */
  host: string | null
  /** null while the automatic place is being prepared, or when it could not be. */
  place: JoinPlace | null
  /** null while the place is being checked. */
  check: PlaceCheck | null
  choice: DepartmentChoice
  error: string | null
  busy: boolean
  onChangeDepartments: () => void
  onChangePlace: (how: 'new' | 'existing') => void
  onStart: () => void
  onBack: () => void
}) {
  const [placeOpen, setPlaceOpen] = useState(false)
  const start = joinStart(check, choice)
  const refused = check?.kind === 'error'
  const showPlaceChoices = placeOpen || refused || (!place && !busy)
  const reopen = check?.kind === 'reopen'

  return (
    <div className="space-y-6">
      <div className="text-center">
        <Buildings size={56} className="mx-auto mb-3 text-primary" weight="duotone" />
        <h1 className="text-page font-bold text-text mb-2">
          {reopen ? `${company.name} を開きます` : `${company.name} に参加します`}
        </h1>
        <p className="text-text-muted">
          内容を確かめて［始める］を押してください。この PC に置く部署は、あとから設定で変えられます
        </p>
      </div>

      <div className="rounded-control border border-[color:var(--color-border)] divide-y divide-[color:var(--color-border)] overflow-hidden">
      <dl className="divide-y divide-[color:var(--color-border)]">
        <Row label="会社">
          <span className="text-text">{company.name}</span>
          {host && <span className="ml-2 text-body text-text-muted">（{host}）</span>}
        </Row>

        {check?.kind === 'firstSetup' && check.departments.length > 0 && (
          <Row label="この PC に置く部署" action={<LinkButton onClick={onChangeDepartments} disabled={busy}>{choice === null ? '選ぶ' : '変える'}</LinkButton>}>
            <DepartmentsChosen check={check} choice={choice} />
          </Row>
        )}
        {reopen && (
          <Row label="この PC に置く部署">
            <span className="text-text">この PC で前に選んだ部署のまま</span>
          </Row>
        )}

        <Row label="ファイルの置き場所" action={!showPlaceChoices && place && <LinkButton onClick={() => setPlaceOpen(true)} disabled={busy}>変える</LinkButton>}>
          {place
            ? <div data-company-place className="text-text break-all">{place.path}</div>
            : <div className="text-text-muted">置き場所を選んでください</div>}
          {place && !check && (
            <div className="flex items-center gap-1.5 text-body text-text-muted"><SpinnerGap size={14} className="animate-spin" />確かめています</div>
          )}
          {place && check && !refused && (
            <div className="text-body text-text-muted">
              {reopen ? 'この PC にある会社のフォルダを使います' : place.automatic ? 'ふつうはこのままで大丈夫です' : 'ここに会社のフォルダを作ります'}
            </div>
          )}
          {refused && <div role="alert" className="mt-1 text-body text-danger-text">{check.message} 置き場所を変えてください。</div>}
        </Row>
      </dl>

        {showPlaceChoices && (
          <div role="group" aria-label="置き場所を変えたいとき（任意）" className="space-y-2 bg-bg p-4">
            <p className="text-body text-text-muted">置き場所を変えるときだけ選んでください。</p>
            <PlaceChoice icon={<FolderPlus size={18} className="text-primary" />} disabled={busy} onClick={() => { setPlaceOpen(false); onChangePlace('new') }}>
              別の場所に作る（フォルダを選ぶ）
            </PlaceChoice>
            <PlaceChoice icon={<FolderOpen size={18} className="text-primary" />} disabled={busy} onClick={() => { setPlaceOpen(false); onChangePlace('existing') }}>
              この PC にすでにある会社のフォルダを使う
            </PlaceChoice>
            {placeOpen && !refused && place && (
              <LinkButton onClick={() => setPlaceOpen(false)}>このままにする</LinkButton>
            )}
          </div>
        )}
      </div>

      {check?.kind === 'working' && (
        <div className="space-y-1 text-body text-text-muted">
          <p>{WORKING_FOLDER_NOTE}</p>
          <p data-working-folder-backup>{WORKING_FOLDER_BACKUP_NOTE}</p>
        </div>
      )}

      <ErrorNotice error={error} />

      <div className="space-y-3">
        <button
          type="button"
          onClick={onStart}
          disabled={!start || !place || busy}
          className="w-full flex items-center justify-center gap-2 bg-primary hover:bg-primary-hover disabled:opacity-disabled disabled:cursor-not-allowed text-on-primary rounded-control px-4 py-3 transition-colors font-medium"
        >
          {busy ? <SpinnerGap size={20} className="animate-spin" /> : <><CheckCircle size={20} />始める</>}
        </button>
        <div className="text-center">
          <LinkButton onClick={onBack} disabled={busy}>会社の一覧に戻る</LinkButton>
        </div>
      </div>
    </div>
  )
}

function DepartmentsChosen({ check, choice }: { check: Extract<PlaceCheck, { kind: 'firstSetup' }>; choice: DepartmentChoice }) {
  if (choice === null) return <span className="text-text-muted">まだ選んでいません</span>
  const names = choice === 'all' ? ['すべての部署'] : chosenDepartmentNames(check.departments, choice)
  const fromMembership = choice !== 'all' && choice.length === check.mine.length && choice.every(f => check.mine.includes(f))
  return (
    <>
      <div className="text-text">{names.join('・')}</div>
      <div className="text-body text-text-muted">
        {fromMembership ? 'あなたの所属の部署です。' : ''}ほかの部署もあとから置けます
      </div>
    </>
  )
}

function Row({ label, action, children }: { label: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex gap-4 px-4 py-3">
      <dt className="w-36 flex-shrink-0 text-body text-text-muted">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
      {action && <div className="flex-shrink-0">{action}</div>}
    </div>
  )
}

function LinkButton({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className="text-body text-link hover:underline disabled:opacity-disabled">
      {children}
    </button>
  )
}

function PlaceChoice({ icon, disabled, onClick, children }: { icon: React.ReactNode; disabled: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="w-full flex items-center gap-3 rounded-control border border-[color:var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-left text-body text-text hover:border-selected-border"
    >
      {icon}
      {children}
    </button>
  )
}
