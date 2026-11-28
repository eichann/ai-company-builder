// 「同期しないファイル」 (詳しい設定): the company's root .gitignore. Everyone reads it; only owners and admins
// edit and save it (useGitignoreDraft), since it applies to the whole company once synced.
import { Callout, Card, SectionHeader, SubHeading } from '../../../shared/ui/primitives'
import type { GitignoreDraft } from '../hooks/useGitignoreDraft'
import { SaveFooter } from './SaveFooter'
import { CODE, TEXTAREA } from './fieldStyles'

export function GitignoreSection({ gitignore, rootPath }: { gitignore: GitignoreDraft; rootPath: string }) {
  return (
    <div ref={gitignore.loadRef} className="flex min-h-full flex-col">
      <div className="flex-1 space-y-5 px-8 pb-8 pt-7">
        <SectionHeader title="同期しないファイル" description={<>ここに書いたファイルやフォルダは、チームと共有されません（<code className={CODE}>.gitignore</code>）。</>} />
        {!gitignore.editable && (
          <Callout tone="info"><p>会社全体に効くので、変えられるのは管理者だけです。</p></Callout>
        )}
        {gitignore.error && !gitignore.editable && <Callout tone="danger">{gitignore.error}</Callout>}
        <textarea
          value={gitignore.content}
          readOnly={!gitignore.editable}
          onChange={e => gitignore.edit(e.target.value)}
          aria-label=".gitignore の内容"
          placeholder="# 同期対象外にするファイル/フォルダ&#10;.DS_Store&#10;node_modules/&#10;*.log"
          className={`${TEXTAREA} h-80`}
          spellCheck={false}
        />
        <div className="grid grid-cols-2 gap-4">
          <Card className="p-4 text-body text-text-muted">
            <SubHeading>自動で追加される項目</SubHeading>
            <ul className="mt-2 space-y-1.5">
              <li><code className={CODE}>.backups/</code> バックアップフォルダ</li>
              <li><code className={CODE}>.env</code> / <code className={CODE}>.env.*</code> APIキーなどの秘密情報</li>
              <li><code className={CODE}>100MB以上のファイル</code> 大容量ファイル</li>
            </ul>
          </Card>
          <Card className="p-4 text-body text-text-muted">
            <SubHeading>書き方</SubHeading>
            <ul className="mt-2 space-y-1.5">
              <li><code className={CODE}>*.log</code> すべての .log ファイル</li>
              <li><code className={CODE}>folder/</code> フォルダ全体</li>
              <li><code className={CODE}># comment</code> コメント</li>
            </ul>
          </Card>
        </div>
      </div>
      {gitignore.editable && (
        <SaveFooter dirty={gitignore.dirty} error={gitignore.error} save={gitignore.save} onError={gitignore.setError}
          where={<>保存先: <code className={CODE}>{rootPath}/.gitignore</code></>} />
      )}
    </div>
  )
}
