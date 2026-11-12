/**
 * The core connectors built into ACB (基幹のつなぎ先, stage 3 A1,
 * `.claude/rules/connector-roles.md` "Built-in connectors"): connectors whose
 * code ships with the app (they need code, not only a declaration), yet are
 * put in and taken out like a plugin — shown in the admin console's
 * 「つないでいるサービス」, switched on and off by the company's admin, stopped
 * for every company by the operator's stop file (`<PLUGINS_DIR>/stopped`
 * naming the id). They are not packages in `PLUGINS_DIR`.
 *
 * Each declares the core roles it serves (`shared/core/connector-roles.ts`)
 * and its own optional capabilities: things only this service has (Google
 * Drive), which a business plugin may use by name but the core app never asks
 * for. Google stays where its code is (plan §5-2); this is its declaration.
 * Slack (A3) serves the chat role; its code is services/slack-*.ts.
 *
 * Pure: imports only shared/core.
 */
import type { RoleServing } from './connector-roles'
import { isDriveId } from './google-drive'

export interface BuiltinConnector {
  /** The connector's id: the role resolver's connector id and the operator stop file's name. */
  id: string
  /** The service's name as people know it (shown as is). */
  label: string
  /** One sentence for the admin's list: what it lets ACB do. */
  summary: string
  /** The core roles it serves, with their operations and optional role capabilities. */
  servings: readonly RoleServing[]
  /** Its own capabilities beyond the roles (not roles: the core app never asks for them). */
  capabilities: readonly { id: string; label: string }[]
  /**
   * Places outside ACB where a scheduled job's deliverables may go (`jobs.md` "A deliverable place outside";
   * owner decision 2026-11-11: a job names `{ connector, kind, ref }`, never one service's own field). Each
   * kind: its words, who chooses the exact place (`responsible`: the job's responsible person, when accepting —
   * the only way under a per-member permission such as Drive's `drive.file`), and the connector's AI routes
   * (`<METHOD> <path under /api/records-ai>`) and app tools a run of such a job may use for it — nothing else
   * of the connector. The connector's own route checks the run puts only into the chosen place.
   */
  deliveryPlaces: readonly DeliveryPlaceKind[]
}

/** A kind of place a connector offers for a scheduled job's deliverables (`BuiltinConnector.deliveryPlaces`). */
export interface DeliveryPlaceKind {
  kind: string
  label: string
  chosenBy: 'responsible'
  routes: readonly string[]
  tools: readonly string[]
  /** One sentence for the run's first message: how to put a file there (`{ref}`: the chosen place's id). */
  howToPut: string
  /**
   * One sentence for the first message of a run after 「もう一度」, said after the files earlier runs of the occurrence
   * already put there (`JobMadeBefore.file`): that the run may update that same file instead of making a new one.
   */
  howToUpdateMadeBefore: string
  /** Whether a value is one of this place's file ids (what the run names to update a file; Drive: `isDriveId`). */
  isFileId: (v: unknown) => boolean
  /** For the screens: how long a chosen place lasts and what ends it (the connector's own rule). */
  lapseNote: string
}

export const BUILTIN_CONNECTORS = {
  google: {
    id: 'google',
    label: 'Google Workspace',
    summary: 'メンバーが自分で許可すると、予定・メール・Meet の議事録を ACB が読み、本人が確かめたメールを送れます。',
    servings: [
      { role: 'calendar', operations: ['read'], capabilities: [] },
      { role: 'mail', operations: ['read', 'send'], capabilities: [] },
      { role: 'meetings', operations: ['read'], capabilities: ['transcript', 'attendees'] },
    ],
    capabilities: [{ id: 'drive', label: 'Drive で選んだものを読む・置く' }],
    deliveryPlaces: [{
      kind: 'drive_folder', label: 'Google Drive のフォルダ', chosenBy: 'responsible',
      // The status (its own folder and the files its puts made there), the put, and a put's receipt; never a read or a pick.
      routes: ['GET /google/drive/status', 'POST /google/drive/put', 'GET /google/drive/puts/:putId'],
      tools: ['drive_picked', 'drive_put'],
      lapseNote: '選んだフォルダは、選んでから90日たつと選び直しが要ります（Google Drive のフォルダを ACB が使える期間）。',
      howToPut: 'できたものは、保存したファイルを drive_put で Google Drive のフォルダ（folderId: {ref}）に置きます（Markdown / HTML は as: "google_doc" で Google ドキュメントにする）。置けるのはこのフォルダだけです。前の回に作ったファイルを直すときは drive_picked で確かめ、その fileId を updateFileId に渡して上書きします（省くと新しいファイルが増えます）。置いたファイルはやることに自動でつながります。リンクは job_report の summary にも書いてください。',
      howToUpdateMadeBefore: '上の Google Drive のファイル（fileId つき）は、前回この仕事がこのフォルダに置いたものです。手順書が「更新する」「前のものを直す」などと言うときは、新しいファイルを作らずに、drive_put の updateFileId にその fileId を渡して同じファイルを上書きしてください（drive_picked にも出ています）。上書きが断られたとき（Drive で人が変えていた、など）は上書きせず、新しいファイルとして置いて、そのことを job_report の summary に書いてください。',
      isFileId: isDriveId,
    }],
  },
  slack: {
    id: 'slack',
    label: 'Slack',
    summary: 'メンバーが自分で許可すると、自分あての DM とメンションを ACB が受け取り、本人が確かめた返事を送れます。大事な知らせを会社のボットが DM で届けます。',
    servings: [
      { role: 'chat', operations: ['receive', 'reply'], capabilities: [] },
    ],
    capabilities: [],
    deliveryPlaces: [],
  },
} as const satisfies Record<string, BuiltinConnector>

export type BuiltinConnectorId = keyof typeof BUILTIN_CONNECTORS

export const BUILTIN_CONNECTOR_IDS = Object.keys(BUILTIN_CONNECTORS) as BuiltinConnectorId[]

export const isBuiltinConnectorId = (v: unknown): v is BuiltinConnectorId =>
  typeof v === 'string' && Object.prototype.hasOwnProperty.call(BUILTIN_CONNECTORS, v)
