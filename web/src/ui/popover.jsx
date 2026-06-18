import * as React from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { cn } from '../lib/cn.js';

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;

// Content is portalled to <body> (outside #ui-root), so it carries `pid-ui` to
// inherit the scoped reset + tokens, and `.surface` for the unified material.
export const PopoverContent = React.forwardRef(function PopoverContent(
  { className, align = 'end', sideOffset = 10, ...props },
  ref
) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={ref}
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'pid-ui surface z-50 rounded-2xl text-card-foreground outline-none',
          'data-[state=open]:animate-fade-in',
          className
        )}
        style={{ boxShadow: 'var(--shadow-2)' }}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
});
