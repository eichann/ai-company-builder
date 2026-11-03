import { redirect } from 'next/navigation'

// The former page 「権限」 is 「フォルダ」 › 「だれが変えられるか」 (管理画面の見直し 2-3).
export default async function PermissionsMoved({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  redirect(`/companies/${encodeURIComponent(id)}/folders`)
}
