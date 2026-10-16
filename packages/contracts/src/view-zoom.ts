import type { ReadingContext } from './index';

/** A projection of one synchronous Core event, never a replacement workspace. */
export interface ViewZoomDelta {
  action: 'view-zoom-state';
  seq: number;
  viewId: string;
  documentId: string;
  windowId: string;
  zoom: number;
  context?: ReadingContext;
}

export interface ViewZoomRetired {
  action: 'view-zoom-retired';
  seq: number;
  viewId: string;
}
