import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'
import { cn } from '@/lib/utils'

const badgeVariants = cva('inline-flex h-5 items-center gap-1 rounded-sm px-1.5 text-xs font-medium whitespace-nowrap [&_svg]:size-3', {
  variants: {
    variant: {
      default: 'bg-secondary text-secondary-foreground',
      outline: 'border border-border text-foreground',
      mono: 'bg-secondary font-mono text-secondary-foreground',
      manual: 'bg-status-awaiting-manual-bg text-status-awaiting-manual',
      destructive: 'bg-status-failed-bg text-status-failed',
    },
  },
  defaultVariants: { variant: 'default' },
})

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}
