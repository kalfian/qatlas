import * as ToggleGroupPrimitive from '@radix-ui/react-toggle-group'
import { cn } from '@/lib/utils'

export interface SegmentedOption<T extends string> {
  value: T
  label: string
}

/** Segmented control (single select) di atas Radix ToggleGroup. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  className,
  disabled,
}: {
  value: T
  onChange: (v: T) => void
  options: SegmentedOption<T>[]
  ariaLabel: string
  className?: string
  disabled?: boolean
}) {
  return (
    <ToggleGroupPrimitive.Root
      type="single"
      value={value}
      onValueChange={(v) => v && onChange(v as T)}
      aria-label={ariaLabel}
      disabled={disabled}
      className={cn('inline-flex h-8 items-center rounded-md border border-input bg-muted p-0.5', className)}
    >
      {options.map((o) => (
        <ToggleGroupPrimitive.Item
          key={o.value}
          value={o.value}
          className="h-full flex-1 rounded-[4px] px-2.5 text-xs font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm"
        >
          {o.label}
        </ToggleGroupPrimitive.Item>
      ))}
    </ToggleGroupPrimitive.Root>
  )
}
