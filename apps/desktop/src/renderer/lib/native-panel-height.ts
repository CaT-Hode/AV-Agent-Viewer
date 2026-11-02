import { createContext } from 'react';

// Geometry ownership stays in the parent React tree, even for popup DOM.
export const NativePanelHeightContext = createContext<((height: number, seedY: number, seedSize: number) => void) | undefined>(undefined);
