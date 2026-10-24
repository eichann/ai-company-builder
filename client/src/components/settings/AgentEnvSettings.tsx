import { useEffect, useId, useState } from 'react'
import { Button, Callout, SubHeading } from './ui'

// Settings → AIに渡す環境変数: extra environment variable names the AI (and
// the commands it runs) may see on this computer. By default the AI gets only
// what the CLIs and ordinary tools need (electron/agents/agent-env.ts);
// secret-looking names are refused even here. Names only — values come from
// the member's own environment. Stored in this computer's config.json, never synced.

const CODE = 'rounded bg-zinc-100 px-1 py-px font-mono text-[12px] text-zinc-700 dark:bg-white/10 dark:text-zinc-200'
const TEXTAREA = 'h-32 w-full resize-none rounded-lg border border-zinc-200 bg-white px-3 py-2 font-mono text-[13px] leading-relaxed text-zinc-900 placeholder:text-zinc-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-100 dark:placeholder:text-zinc-500'

const parse = (text: string) => text.split(/[\s,]+/).map(name => name.trim()).filter(Boolean)

export function AgentEnvSettings() {
  const [text, setText] = useState('')
  const [saved, setSaved] = useState<string[] | null>(null)
  const [refused, setRefused] = useState<{ invalid: string[]; denied: string[] }>({ invalid: [], denied: [] })
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const inputId = useId()
  const descriptionId = useId()

  useEffect(() => {
    let alive = true
    window.electronAPI.getAgentEnvPassthrough()
      .then(names => { if (alive) { setSaved(names); setText(names.join('\n')) } })
      .catch(() => { if (alive) { setSaved([]); setStatus('error') } })
    return () => { alive = false }
  }, [])

  const save = async () => {
    setStatus('saving')
    try {
      const result = await window.electronAPI.setAgentEnvPassthrough(parse(text))
      setSaved(result.names)
      setText(result.names.join('\n'))
      setRefused({ invalid: result.invalid, denied: result.denied })
      setStatus('saved')
    } catch {
      setStatus('error')
    }
  }

  const dirty = saved !== null && parse(text).join('\n') !== saved.join('\n')

  return (
    <div className="space-y-4">
      <div>
        <SubHeading>AIに追加で渡す環境変数の名前</SubHeading>
        <p id={descriptionId} className="mt-1 text-[13px] leading-relaxed text-zinc-500 dark:text-zinc-400">
          AI（Claude Code・Codex）には、動作に必要な環境変数（<code className={CODE}>PATH</code>・<code className={CODE}>HOME</code>・言語設定・プロキシなど）だけを渡しています。
          スキルがほかの環境変数を必要とするときだけ、その名前を1行に1つ書いてください。値はこのPCの環境から読まれます。
        </p>
      </div>
      <Callout tone="warning" title="ここに書いた環境変数は、AIと、AIが実行するコマンドから見えるようになります">
        トークン・パスワード・APIキーのような名前（<code className={CODE}>…_TOKEN</code>・<code className={CODE}>…_SECRET</code>・<code className={CODE}>…_API_KEY</code>・<code className={CODE}>AWS_…</code> など）は追加できません。
        スキルが使うAPIキーは「APIキー」（.env）に保存してください。
      </Callout>
      <textarea
        id={inputId}
        aria-label="AIに追加で渡す環境変数の名前"
        aria-describedby={descriptionId}
        value={text}
        onChange={e => { setText(e.target.value); setStatus('idle') }}
        placeholder={'例: JAVA_HOME\nPYTHONPATH'}
        spellCheck={false}
        disabled={saved === null}
        className={TEXTAREA}
      />
      {(refused.denied.length > 0 || refused.invalid.length > 0) && (
        <div role="alert" className="space-y-1 text-[13px] text-amber-600 dark:text-amber-400">
          {refused.denied.length > 0 && <p>秘密情報の可能性がある名前のため追加しませんでした：{refused.denied.join('、')}</p>}
          {refused.invalid.length > 0 && <p>環境変数の名前として使えないため追加しませんでした：{refused.invalid.join('、')}</p>}
        </div>
      )}
      <div className="flex items-center gap-3">
        <Button variant="primary" onClick={save} disabled={!dirty || status === 'saving'}>
          {status === 'saving' ? '保存中…' : '保存'}
        </Button>
        <span role="status" className="text-[12px] text-zinc-500 dark:text-zinc-400">
          {status === 'saved' ? '保存しました。AIへの次の依頼から反映されます。' : status === 'error' ? '保存できませんでした。もう一度お試しください' : 'このPCにだけ保存され、同期されません。'}
        </span>
      </div>
    </div>
  )
}
