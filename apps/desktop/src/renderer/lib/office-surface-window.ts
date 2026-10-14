import type { OfficeSurfaceState, OfficeSurfaceWindow, OfficeSurfaceWindowIdentity } from '../../../../../packages/contracts/src/office-surface';
/** Never accept a raw external numeric ID: the live engine window lease is the authority. */
export function officeSurfaceWindowOwned(state: OfficeSurfaceState | undefined, identity: OfficeSurfaceWindowIdentity): OfficeSurfaceWindow | undefined {
  if (!state || !Number.isSafeInteger(identity.windowId) || identity.windowId <= 0 || typeof identity.windowInstanceId !== 'string' || !identity.windowInstanceId || state.viewId !== identity.viewId || state.sessionId !== identity.sessionId || state.engineEpoch !== identity.engineEpoch) return;
  return state.windows?.find(window => window.id === identity.windowId && window.instanceId === identity.windowInstanceId && window.visible);
}
export function officeWindowPoint(client: { x: number; y: number }, bounds: { x: number; y: number; width: number; height: number }, size: { width: number; height: number }) {
  if (bounds.width <= 0 || bounds.height <= 0 || size.width <= 0 || size.height <= 0 || ![client.x, client.y, bounds.x, bounds.y, bounds.width, bounds.height, size.width, size.height].every(Number.isFinite)) throw new Error('Office 对话框坐标无效。');
  return { x: (client.x - bounds.x) * size.width / bounds.width, y: (client.y - bounds.y) * size.height / bounds.height };
}
