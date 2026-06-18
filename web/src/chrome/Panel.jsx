import React from 'react';
import { cn } from '../lib/cn.js';

// ONE canonical floating panel: the unified .surface recipe + outer radius +
// resting elevation. Replaces the ad-hoc mix of .glass / opaque Card / bare divs
// so every floating chrome surface reads as the same material. Pass a different
// element via `as` (e.g. as="section"); extra className composes on top.
export function Panel({ as: Tag = 'div', className, style, children, ...rest }) {
  return (
    <Tag
      className={cn('surface rounded-2xl text-card-foreground', className)}
      style={{ boxShadow: 'var(--shadow-1)', ...style }}
      {...rest}
    >
      {children}
    </Tag>
  );
}

export default Panel;
