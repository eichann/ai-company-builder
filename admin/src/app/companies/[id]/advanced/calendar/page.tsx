'use client'

import { TaskSettingsPage } from '@/components/advanced/task-settings-page'

/** 「詳しい設定 › 会社の暦」: the company's holidays (was part of 「やることの一覧」). */
export default function CalendarSettingsPage() {
  return <TaskSettingsPage part="calendar" />
}
