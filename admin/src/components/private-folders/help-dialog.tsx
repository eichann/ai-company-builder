'use client'

import { useState } from 'react'
import { Question } from '@phosphor-icons/react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { PRIVATE_FOLDER_HELP, PRIVATE_FOLDER_HELP_TITLE } from '@/lib/private-folder-help'

/** 「非公開フォルダについて」: what a private folder does — and does not — protect. */
export function PrivateFolderHelpDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{PRIVATE_FOLDER_HELP_TITLE}</DialogTitle>
          <DialogDescription>選んだ人だけに届くフォルダです。守れることと、守れないことがあります。</DialogDescription>
        </DialogHeader>
        <ol className="grid gap-4" aria-label={PRIVATE_FOLDER_HELP_TITLE}>
          {PRIVATE_FOLDER_HELP.map((item, i) => (
            <li key={item.title} className="flex gap-3">
              <span
                className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium tabular-nums text-muted-foreground"
                aria-hidden="true"
              >
                {i + 1}
              </span>
              <div className="min-w-0 space-y-0.5">
                <h3 className="text-sm font-medium">{item.title}</h3>
                <p className="text-sm leading-relaxed text-muted-foreground">{item.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </DialogContent>
    </Dialog>
  )
}

/** A button / link that opens the help. */
export function PrivateFolderHelpButton({ variant = 'button' }: { variant?: 'button' | 'link' }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      {variant === 'link' ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1 rounded text-sm font-medium text-brand underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <Question size={14} />
          {PRIVATE_FOLDER_HELP_TITLE}
        </button>
      ) : (
        <Button type="button" variant="outline" onClick={() => setOpen(true)}>
          <Question />
          {PRIVATE_FOLDER_HELP_TITLE}
        </Button>
      )}
      <PrivateFolderHelpDialog open={open} onOpenChange={setOpen} />
    </>
  )
}
