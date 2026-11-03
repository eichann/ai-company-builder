import { redirect } from 'next/navigation'

// The former page 「非公開フォルダ」 is 「フォルダ」 › 「見られる人を決めたフォルダ」 (管理画面の見直し 2-3).
export default async function PrivateFoldersMoved({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  redirect(`/companies/${encodeURIComponent(id)}/folders?tab=private`)
}
