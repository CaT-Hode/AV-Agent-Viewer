import { createContext } from 'react';

// Geometry ownership stays in the parent React tree, even for popup DOM.
export const NativePanelHeightContext = createContext<((height: number) => void) | undefined>(undefined);
