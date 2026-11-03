import { redirect } from 'next/navigation'

// The former page moved into 「詳しい設定」 (管理画面の見直し 2-3); old links and bookmarks lead there.
export default async function AgentEventsMoved({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { id } = await params
  const query = new URLSearchParams()
  for (const [k, v] of Object.entries(await searchParams)) for (const one of [v].flat()) if (one !== undefined) query.append(k, one)
  const rest = query.toString()
  redirect(`/companies/${encodeURIComponent(id)}/advanced/ai-safety/events${rest ? `?${rest}` : ''}`)
}
