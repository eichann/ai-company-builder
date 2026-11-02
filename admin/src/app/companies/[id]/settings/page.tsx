import { redirect } from 'next/navigation'

// The former page moved into 「詳しい設定」 (管理画面の見直し 2-3); old links and bookmarks lead there.
export default async function SettingsMoved({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  redirect(`/companies/${encodeURIComponent(id)}/advanced/info`)
}
