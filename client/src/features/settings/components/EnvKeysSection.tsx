// 「API キー・環境変数（この PC）」 (詳しい設定): the former 「APIキー（このPC）」 and 「環境変数（.env）」 pages
// as one. Saved values never reach the renderer: each name shows only whether it is set and its last 4
// (env:status); a new value is typed here and sent with env:update.
import { useState, type ReactNode } from 'react'
import { ArrowCounterClockwise, Eye, EyeSlash, Plus, Trash } from '@phosphor-icons/react'
import { Button, Callout, Card, SectionHeader, SubHeading } from '../../../shared/ui/primitives'
import type { EnvVarStatus } from '../../../../shared/env-file'
import { envStatusLabel } from '../model'
import { COMMON_API_KEYS, type EnvDraft } from '../hooks/useEnvDraft'
import { LegacyKeysNote, MoveEnvKeysCard } from './MoveEnvKeysCard'
import { SaveFooter } from './SaveFooter'
import { CODE, INPUT, TEXTAREA } from './fieldStyles'

interface Props {
  env: EnvDraft
  companyId: string
  rootPath: string
  onOpenOwnKeys: () => void
}

export function EnvKeysSection({ env, companyId, rootPath, onOpenOwnKeys }: Props) {
  const [visible, setVisible] = useState<Set<string>>(new Set())
  const toggleVisible = (key: string) => setVisible(prev => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })
  const [pasteOpen, setPasteOpen] = useState(env.pasted.trim() !== '')

  return (
    <div ref={env.loadRef} className="flex min-h-full flex-col">
      <div className="flex-1 space-y-5 px-8 pb-8 pt-7">
        <SectionHeader title="API キー・環境変数（この PC）" description="Skill やスクリプトが使う値です。この PC だけに保存され、同期されません。" />
        <Callout tone="info">ふつうは使いません。Skill を作る人や管理者に「ここに入れて」と言われたときだけ使います。</Callout>
        <LegacyKeysNote onOpenOwnKeys={onOpenOwnKeys} />
        <MoveEnvKeysCard companyId={companyId} rootPath={rootPath} env={env.status} onMoved={env.reload} />
        {env.loading ? (
          <p className="py-6 text-body text-text-muted">読み込み中…</p>
        ) : (
          <>
            <Card className="divide-y divide-[color:var(--color-border)]">
              <div className="p-5">
                <SubHeading>よく使うAPIキー</SubHeading>
                <div className="mt-4 space-y-3">
                  {COMMON_API_KEYS.map(({ key, label, placeholder }) => (
                    <EnvKeyRow
                      key={key}
                      name={key}
                      label={<label htmlFor={`env-${key}`} className="w-32 shrink-0 text-body text-text-muted">{label}</label>}
                      inputId={`env-${key}`}
                      status={env.status[key]}
                      draft={env.drafts[key] ?? ''}
                      placeholder={placeholder}
                      visible={visible.has(key)}
                      removed={env.removed.has(key)}
                      onDraft={value => env.setDraft(key, value)}
                      onToggleVisible={() => toggleVisible(key)}
                      onToggleRemoved={() => env.toggleRemoved(key)}
                    />
                  ))}
                </div>
              </div>
              <div className="p-5">
                <SubHeading>カスタム環境変数</SubHeading>
                <div className="mt-4 space-y-3">
                  {env.customKeys.map(key => (
                    <EnvKeyRow
                      key={key}
                      name={key}
                      label={<code className={`${CODE} w-44 shrink-0 truncate py-1.5`} title={key}>{key}</code>}
                      status={env.status[key]}
                      draft={env.drafts[key] ?? ''}
                      placeholder="値"
                      visible={visible.has(key)}
                      removed={env.removed.has(key)}
                      onDraft={value => env.setDraft(key, value)}
                      onToggleVisible={() => toggleVisible(key)}
                      onToggleRemoved={() => (key in env.status ? env.toggleRemoved(key) : env.removeAddedKey(key))}
                    />
                  ))}
                  <div className="flex items-center gap-3">
                    <input
                      type="text"
                      value={env.newKeyName}
                      onChange={e => env.setNewKeyName(e.target.value.toUpperCase())}
                      placeholder="新しいキー名"
                      aria-label="新しいキー名"
                      onKeyDown={e => e.key === 'Enter' && env.addCustomKey()}
                      className={`${INPUT} w-44 shrink-0 border-dashed font-mono`}
                    />
                    <Button variant="ghost" className="shrink-0 whitespace-nowrap" onClick={env.addCustomKey} disabled={!env.newKeyName.trim()}>
                      <Plus size={14} />追加
                    </Button>
                  </div>
                </div>
              </div>
            </Card>

            <Card className="p-5">
              <button type="button" aria-expanded={pasteOpen} onClick={() => setPasteOpen(v => !v)}
                className="text-body font-medium text-link hover:text-link-hover focus-visible:outline-none focus-visible:ring-focus focus-visible:ring-focus-ring">
                {pasteOpen ? 'まとめて貼り付けるのをやめる' : 'まとめて貼り付ける'}
              </button>
              {pasteOpen && (
                <div className="mt-3 space-y-2">
                  <p className="text-small text-text-muted">1行に1つ、<code className={CODE}>KEY=value</code> の形で貼り付けてください。ここに書いた名前だけが変わり、ほかの項目はそのまま残ります。<code className={CODE}>#</code> で始まる行と、値が空の行は無視されます。</p>
                  <textarea
                    value={env.pasted}
                    onChange={e => env.setPasted(e.target.value)}
                    aria-label=".env に追加する内容"
                    placeholder="OPENAI_API_KEY=sk-...&#10;ANTHROPIC_API_KEY=sk-ant-..."
                    className={`${TEXTAREA} h-40`}
                    spellCheck={false}
                  />
                </div>
              )}
            </Card>

            <Callout tone="info">
              <p>スクリプトからは <code className={CODE}>process.env.OPENAI_API_KEY</code> などで使えます。</p>
              <p className="mt-1">保存したキーは安全のため画面に表示しません（末尾4文字だけ表示します）。変えるときは新しいキーを入力して保存してください。</p>
              <p className="mt-1">ここに入れた値は、このPCにだけ保存され、同期されません。</p>
            </Callout>
          </>
        )}
      </div>
      <SaveFooter dirty={env.dirty} error={env.error} save={env.save} onError={env.setError}
        where={<>保存先: <code className={CODE}>{rootPath}/.env</code></>} />
    </div>
  )
}

/** One .env name: its saved status (never the value), a box for a new value, and removal. */
function EnvKeyRow({ name, label, inputId, status, draft, placeholder, visible, removed, onDraft, onToggleVisible, onToggleRemoved }: {
  name: string
  label: ReactNode
  inputId?: string
  status: EnvVarStatus | undefined
  draft: string
  placeholder: string
  visible: boolean
  removed: boolean
  onDraft: (value: string) => void
  onToggleVisible: () => void
  onToggleRemoved: () => void
}) {
  const saved = !!status?.set
  const statusText = removed ? '保存すると削除されます' : envStatusLabel(status)
  return (
    <div className="flex items-center gap-3">
      {label}
      <div className="relative flex-1">
        <input
          id={inputId}
          type={visible ? 'text' : 'password'}
          value={removed ? '' : draft}
          disabled={removed}
          onChange={e => onDraft(e.target.value)}
          placeholder={removed ? statusText : saved ? `${statusText}。変更するときだけ入力` : placeholder}
          aria-label={inputId ? undefined : `${name} の値`}
          aria-describedby={`env-status-${name}`}
          className={`${INPUT} w-full pr-10 font-mono disabled:opacity-disabled`}
        />
        <span id={`env-status-${name}`} className="sr-only">{statusText}</span>
        <button
          type="button"
          onClick={onToggleVisible}
          aria-label={visible ? '隠す' : '表示する'}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-small p-1 text-text-subtle hover:text-text"
        >
          {visible ? <EyeSlash size={16} /> : <Eye size={16} />}
        </button>
      </div>
      {saved || !inputId ? (
        <button
          type="button"
          onClick={onToggleRemoved}
          aria-label={removed ? `${name} の削除を取り消す` : `${name} を削除`}
          className="rounded-control p-2 text-text-subtle transition-colors hover:bg-danger-bg hover:text-danger-text"
        >
          {removed ? <ArrowCounterClockwise size={16} /> : <Trash size={16} />}
        </button>
      ) : (
        <span className="w-8 shrink-0" aria-hidden />
      )}
    </div>
  )
}
