/**
 * The rejection sections the push checker prints (stderr → the client's
 * "remote:" lines). Wording and layout are a contract: desktop clients parse
 * them (client/electron/protected-config.ts and the sync handler), and so does
 * the server's own rejection recorder (lib/push-rejections.ts):
 *
 *     ========================================
 *     [MARKER] <title>
 *     ========================================
 *     <explanation lines — never starting with "- ">
 *       - <path>
 *     ========================================
 *
 * The "- " lines between the marker and the second separator after it are
 * the paths. Every text below is byte-for-byte what the shell hook printed;
 * [WRITE_DENIED] is new and follows the same shape as [PERSONAL_PATH].
 */
import { dedupe, nonEmptyLines, utf8Bytes } from './rules'

const SEP = '========================================'

/** Everything detected for one push, as accumulated byte strings ("\n"-terminated chunks). */
export interface Findings {
  personal: string
  protected: string
  autorun: string
  writeDenied: string
  secrets: string
  gitlinks: string
  winpaths: string
}

export function emptyFindings(): Findings {
  return { personal: '', protected: '', autorun: '', writeDenied: '', secrets: '', gitlinks: '', winpaths: '' }
}

class Out {
  private parts: string[] = []
  /** UTF-8 text line. */
  line(text = ''): void { this.parts.push(utf8Bytes(text) + '\n') }
  /** Byte-string line (already bytes). */
  raw(bytes: string): void { this.parts.push(bytes + '\n') }
  list(accumulated: string): void {
    for (const l of dedupe(nonEmptyLines(accumulated))) this.raw(`  - ${l}`)
  }
  toBuffer(): Buffer { return Buffer.from(this.parts.join(''), 'latin1') }
}

/** The message lines, in the hook's section order. Returns null when nothing was found. */
export function renderReport(f: Findings): Buffer | null {
  const o = new Out()
  let rejected = false

  if (f.personal) {
    o.line()
    o.line(SEP)
    o.line('[PERSONAL_PATH] 個人用フォルダ(.personal)のファイルが含まれています')
    o.line(SEP)
    o.line()
    o.line('以下は個人用フォルダ(.personal)の中のファイルです。')
    o.line('.personal の中身は、誰であっても共有できません:')
    o.list(f.personal)
    o.line()
    o.line('プッシュをブロックしました。これらのファイルを共有対象から外してから')
    o.line('再度同期してください（ACBクライアントは自動で外します。ファイルはPCに残ります）。')
    o.line(SEP)
    o.line()
    rejected = true
  }

  if (f.protected || f.autorun) {
    o.line()
    o.line(SEP)
    o.line('[PROTECTED_CONFIG] 管理者だけが変更できるファイルが含まれています')
    o.line(SEP)
    if (f.protected) {
      o.line()
      o.line('以下のファイルは、チャットのAIが確認なしにコマンドを実行する設定です。')
      o.line('会社のオーナー・管理者だけが追加・変更・削除できます:')
      o.list(f.protected)
    }
    if (f.autorun) {
      o.line()
      o.line('以下のスキル・エージェント・コマンドには、チャットのAIが確認なしに')
      o.line('コマンドを実行する「自動実行の設定」が含まれています。')
      o.line('自動実行の設定は、会社のオーナー・管理者だけが追加・変更できます:')
      // "path<TAB>reason" → a path line and a reason line (first reason per path)
      const seen = new Set<string>()
      for (const l of nonEmptyLines(f.autorun)) {
        const t = l.indexOf('\t')
        const p = t >= 0 ? l.slice(0, t) : l
        const r = t >= 0 ? l.slice(t + 1) : l
        if (seen.has(p)) continue
        seen.add(p)
        o.raw(`  - ${p}`)
        o.raw(`      ${utf8Bytes('（')}${r}${utf8Bytes('）')}`)
      }
    }
    o.line()
    o.line('プッシュをブロックしました。これらのファイルをサーバーの状態に戻してから')
    o.line('再度同期してください（ACBクライアントの同期ボタンから自動で戻せます）。')
    if (f.autorun) o.line('スキル等は、自動実行の設定を取り除けば、そのまま共有できます。')
    o.line('配布が必要な場合は、オーナー・管理者に依頼してください。')
    o.line(SEP)
    o.line()
    rejected = true
  }

  if (f.writeDenied) {
    // Same shape as PERSONAL_PATH: the "  - " lines are the paths; the
    // explanation lines never start with "- ".
    o.line()
    o.line(SEP)
    o.line('[WRITE_DENIED] 変更する権限のないファイルが含まれています')
    o.line(SEP)
    o.line()
    o.line('以下のファイルは、あなたに変更の権限がないフォルダにあります。')
    o.line('追加・変更・削除・移動はできません:')
    o.list(f.writeDenied)
    o.line()
    o.line('プッシュをブロックしました。これらのファイルをサーバーの状態に戻してから')
    o.line('再度同期してください。変更が必要な場合は、オーナー・管理者に依頼してください。')
    o.line(SEP)
    o.line()
    rejected = true
  }

  if (f.secrets) {
    o.line()
    o.line(SEP)
    o.line('[SECRET_DETECTED] シークレットが検出されました')
    o.line(SEP)
    o.line()
    o.line('以下のファイルにAPIキー・シークレットが含まれています:')
    // Entries are already "  - <file> (<pattern>)"; one per line across refs.
    for (const l of dedupe(f.secrets.split('\n'))) o.raw(l)
    o.line()
    o.line('セキュリティのため、このプッシュはブロックされました。')
    o.line('該当ファイルからシークレットを削除してから再度同期してください。')
    o.line(SEP)
    o.line()
    rejected = true
  }

  if (f.gitlinks) {
    o.line()
    o.line(SEP)
    o.line('[GITLINK_DETECTED] 外部リポジトリの参照が検出されました')
    o.line(SEP)
    o.line()
    o.line('以下のフォルダは、中に .git を持つ外部リポジトリ（サブモジュール扱い）です:')
    o.list(f.gitlinks)
    o.line()
    o.line('このまま共有すると、他のメンバーには空フォルダとして見えてしまうため、')
    o.line('プッシュをブロックしました。次のどちらかで解消してください:')
    o.line()
    o.line('  1. このフォルダをACBで配布したい場合:')
    o.line('     フォルダ内の .git を削除（rm -rf <folder>/.git）してから再同期。')
    o.line('     中身が通常ファイルとして取り込まれ、全員に配布されます。')
    o.line('  2. 配布せず手元だけで使う場合:')
    o.line('     そのフォルダを .gitignore に追加してから再同期。')
    o.line('     （ACBクライアントは通常これを自動で行います）')
    o.line(SEP)
    o.line()
    rejected = true
  }

  if (f.winpaths) {
    o.line()
    o.line(SEP)
    o.line('[WINPATH_DETECTED] Windowsで扱えないファイル名が検出されました')
    o.line(SEP)
    o.line()
    o.line('以下のパスはWindowsで作成できないため、このまま共有すると')
    o.line('Windowsを使うメンバー全員の同期が失敗します:')
    o.list(f.winpaths)
    o.line()
    o.line('プッシュをブロックしました。該当のフォルダ・ファイルの名前を変更して')
    o.line('から再度同期してください。Windowsでは次の名前が使えません:')
    o.line('  ・ < > : " \\ | ? * を含む名前')
    o.line('  ・ 末尾がドット( . )やスペースの名前')
    o.line('  ・ CON / PRN / AUX / NUL / COM1〜9 / LPT1〜9 （拡張子付きも不可）')
    o.line('  ・ 大文字小文字だけが異なる同名ファイルの共存')
    o.line(SEP)
    o.line()
    rejected = true
  }

  return rejected ? o.toBuffer() : null
}

/** One-line rejection when the checks themselves could not run (retried by the client's next sync). */
export function hookErrorLine(detail: string): Buffer {
  return Buffer.from(`[HOOK_ERROR] サーバーで変更内容を確認できませんでした（${detail}）。時間をおいて再度同期してください\n`, 'utf8')
}
