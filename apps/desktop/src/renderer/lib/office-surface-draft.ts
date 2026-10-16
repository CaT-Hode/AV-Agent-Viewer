import type {OfficeSurfaceState} from '../../../../../packages/contracts/src/office-surface';
import type {OfficeDraftController,OfficeDraftFlushOptions} from '../components/office/OfficeDrafts';
import {nativeOfficeInteractionBlocked} from '../../../../../packages/contracts/src/native-office';
import type {OfficeSurfaceInputController} from './office-surface-controller';

export function officeSurfaceHasDrafts(input:OfficeSurfaceInputController,state:OfficeSurfaceState|undefined,formula:OfficeDraftController|undefined,options?:OfficeDraftFlushOptions){
  return input.pendingEdit||input.compositionActive||!!input.failure||(options?.preserveSelection ? !!state&&nativeOfficeInteractionBlocked(state) : !!state?.pendingInput)||!!formula?.hasDrafts();
}
/** Visiting or leaving an initializing reader does not create a save barrier.
 * Actual queued input, native edit buffers and formula drafts retain the same
 * strict confirmation path; a later user edit is caught by the owner's second
 * draft check instead of being declared saved by an empty flush. */
export async function flushOfficeSurfaceDraft(input:OfficeSurfaceInputController,state:OfficeSurfaceState|undefined,formula:OfficeDraftController|undefined,synchronize:()=>Promise<void>,options?:OfficeDraftFlushOptions){
  if(options?.preserveSelection){ await formula?.flush(); await input.drain(); return; }
  if(!officeSurfaceHasDrafts(input,state,formula,options))return;
  await formula?.flush();
  await input.flush(synchronize);
}
