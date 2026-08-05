import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef, type ButtonHTMLAttributes } from 'react';

import { cn } from '../../lib/utils.ts';

const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg text-[12.5px] font-medium transition-all outline-none focus-visible:ring-2 focus-visible:ring-accent/55 focus-visible:ring-offset-2 focus-visible:ring-offset-ink-950 disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:size-4',
  {
    variants: {
      variant: {
        default:
          'bg-accent text-white shadow-[0_8px_24px_-10px_rgba(124,140,255,.9)] hover:bg-accent-bright hover:-translate-y-px active:translate-y-0',
        secondary:
          'border border-white/8 bg-white/[.055] text-ink-100 shadow-sm hover:border-white/12 hover:bg-white/[.085]',
        ghost: 'text-ink-400 hover:bg-white/[.06] hover:text-ink-50',
        outline:
          'border border-ink-700/80 bg-ink-900/70 text-ink-200 hover:border-ink-600 hover:bg-ink-850',
        danger: 'bg-p0/12 text-p0 hover:bg-p0/20',
      },
      size: {
        default: 'h-9 px-3.5',
        sm: 'h-8 rounded-md px-2.5 text-[12px]',
        lg: 'h-10 px-4 text-[13px]',
        icon: 'size-8 rounded-md',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
  },
);
Button.displayName = 'Button';

export { buttonVariants };
