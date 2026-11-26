import { useRef, useState, type HTMLAttributes, type RefObject } from 'react';
import { useGlassSurface } from '../lib/useGlassSurface';
import { LiquidGlassSurface } from './LiquidGlassSurface';

type Props = HTMLAttributes<HTMLDivElement> & {
  variant: 'capsule' | 'tooltip';
  bubbleRef?: RefObject<HTMLDivElement | null>;
  position?: { x: number; y: number };
};

export function FeedbackBubble({ variant, bubbleRef, position, children, ...props }: Props) {
  const local = useRef<HTMLDivElement>(null), ref = bubbleRef ?? local;
  const [surface, setSurface] = useState<'light' | 'dark'>();
  useGlassSurface(ref, { onSurface: setSurface, capsuleBounds: position });
  return <div {...props} ref={ref} data-feedback-surface={surface}>
    <LiquidGlassSurface variant={variant} effect={variant === 'tooltip' ? 'frosted' : undefined}/>
    {children}
  </div>;
}
