'use client'

import { GroupsPage } from '@/components/groups/groups-page'

// 見える人のまとまり (owners and admins; server.md "Groups"). Reached from 「メンバー」.
export default function Page() {
  return <GroupsPage />
}
