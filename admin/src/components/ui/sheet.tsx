'use client'

import * as React from 'react'
import { Dialog as SheetPrimitive } from 'radix-ui'
import { X } from '@phosphor-icons/react'

import { cn } from '@/lib/utils'

function Sheet(props: React.ComponentProps<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />
}

function SheetTrigger(props: React.ComponentProps<typeof SheetPrimitive.Trigger>) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />
}

function SheetContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content>) {
  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex h-full w-72 flex-col border-r bg-sidebar shadow-lg transition ease-in-out data-[state=closed]:animate-out data-[state=closed]:slide-out-to-left data-[state=closed]:duration-200 data-[state=open]:animate-in data-[state=open]:slide-in-from-left data-[state=open]:duration-300',
          className
        )}
        {...props}
      >
        {children}
        <SheetPrimitive.Close className="absolute top-3.5 right-3 rounded-md p-1 text-muted-foreground hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none">
          <X size={16} />
          <span className="sr-only">閉じる</span>
        </SheetPrimitive.Close>
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  )
}

function SheetTitle({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return <SheetPrimitive.Title data-slot="sheet-title" className={cn('sr-only', className)} {...props} />
}

function SheetDescription({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return <SheetPrimitive.Description data-slot="sheet-description" className={cn('sr-only', className)} {...props} />
}

export { Sheet, SheetTrigger, SheetContent, SheetTitle, SheetDescription }
