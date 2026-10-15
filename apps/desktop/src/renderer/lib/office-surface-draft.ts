import type {OfficeSurfaceState} from '../../../../../packages/contracts/src/office-surface';
import type {OfficeDraftController} from '../components/office/OfficeDrafts';
import type {OfficeSurfaceInputController} from './office-surface-controller';

export function officeSurfaceHasDrafts(input:OfficeSurfaceInputController,state:OfficeSurfaceState|undefined,formula:OfficeDraftController|undefined){
  return input.pendingEdit||input.compositionActive||!!input.failure||!!state?.pendingInput||!!formula?.hasDrafts();
}
/** Visiting or leaving an initializing reader does not create a save barrier.
 * Actual queued input, native edit buffers and formula drafts retain the same
 * strict confirmation path; a later user edit is caught by the owner's second
 * draft check instead of being declared saved by an empty flush. */
export async function flushOfficeSurfaceDraft(input:OfficeSurfaceInputController,state:OfficeSurfaceState|undefined,formula:OfficeDraftController|undefined,synchronize:()=>Promise<void>){
  if(!officeSurfaceHasDrafts(input,state,formula))return;
  await formula?.flush();
  await input.flush(synchronize);
}
