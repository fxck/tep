import * as React from 'react';

import { cn } from '../lib/cn.js';

const Kbd = React.forwardRef(({ className, ...props }, ref) => (
  <kbd
    ref={ref}
    className={cn(
      'inline-flex items-center rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground',
      className
    )}
    {...props}
  />
));
Kbd.displayName = 'Kbd';

export { Kbd };
