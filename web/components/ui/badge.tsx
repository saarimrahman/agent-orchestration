import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';

import { cn } from '../../lib/utils.ts';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10.5px] leading-none font-medium',
  {
    variants: {
      variant: {
        default: 'border-accent/15 bg-accent/10 text-accent-soft',
        secondary: 'border-white/[.055] bg-white/[.045] text-ink-400',
        outline: 'border-ink-700/70 bg-transparent text-ink-400',
        danger: 'border-p0/20 bg-p0/10 text-p0',
        warning: 'border-p1/20 bg-p1/10 text-p1',
        success: 'border-status-done/20 bg-status-done/10 text-status-done',
        attention: 'border-status-input/20 bg-status-input/10 text-status-input',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

type BadgeProps = HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>;

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
