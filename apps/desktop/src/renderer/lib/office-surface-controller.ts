import { OFFICE_SURFACE_METHODS, isOfficeSurfaceState, type OfficeSurfaceInputEvent, type OfficeSurfaceInputReply, type OfficeSurfaceState } from '../../../../../packages/contracts/src/office-surface';
import type { NativeOfficeRequest } from './native-office-tools';

type InputTarget = Pick<OfficeSurfaceState, 'documentId'|'viewId'|'sessionId'|'engineEpoch'|'partIndex'>;
type InputWaiter = { resolve(value: OfficeSurfaceInputReply): void; reject(error: unknown): void };
type KeyPress = { target: InputTarget; leaseId?: string; releaseQueued: boolean };
type InputJob = { event: OfficeSurfaceInputEvent; target: InputTarget; leaseId?: string; press?: KeyPress; editing: boolean; resolves: InputWaiter['resolve'][]; rejects: InputWaiter['reject'][] };
const inputTarget = (state: OfficeSurfaceState): InputTarget => ({ documentId:state.documentId,viewId:state.viewId,sessionId:state.sessionId,engineEpoch:state.engineEpoch,partIndex:state.partIndex });
const ownsTarget = (target: InputTarget, live?: OfficeSurfaceState) => !!live && target.documentId===live.documentId && target.viewId===live.viewId && target.sessionId===live.sessionId && target.engineEpoch===live.engineEpoch && target.partIndex===live.partIndex;
/** A queued input must never acquire a replacement display's lease. */
export function assertOfficeSurfaceLease(expected: unknown, current: string | undefined) {
  if (!current || expected !== undefined && expected !== current) throw new Error('OFFICE_DISPLAY_EXPIRED');
}
/** Human events remain ordered. Only undispatched consecutive motion/preedit updates may be replaced. */
export class OfficeSurfaceInputController {
  readonly streamId = crypto.randomUUID();
  private sequence = 0;
  private active = true;
  private sending = false;
  private inFlight?: InputJob;
  private editVersion = 0;
  private failed?: Error;
  private jobs: InputJob[] = [];
  private pressedKeys = new Map<string, KeyPress>();
  private acknowledgedKeys = new Set<KeyPress>();
  private queuedEdits = 0;
  private idleWaiters: { resolve(): void; reject(error: unknown): void }[] = [];
  private composing = false;
  private notified = { pending: false, pendingEdit: false, composing: false, failure: undefined as Error | undefined };
  constructor(readonly viewId: string, private options: { request: NativeOfficeRequest; state(): OfficeSurfaceState | undefined; lease?(): string | undefined; beforeInput(): Promise<void>; accept(state: OfficeSurfaceState): void; changed?(): void }) {}
  get pending() { return this.sending || this.jobs.length > 0; }
  /** A physical release/hover needs an acknowledgement, but is not an unsaved edit. */
  get pendingEdit() { return !!this.inFlight?.editing || this.queuedEdits > 0; }
  get compositionActive() { return this.composing; }
  get failure() { return this.failed; }
  private affectsEditing(event: OfficeSurfaceInputEvent) { return event.kind !== 'barrier' && !(event.kind === 'key' && (event.phase === 'up' || ['Control','Shift','Alt','Meta'].includes(event.key))) && !(event.kind === 'pointer' && event.phase === 'move' && event.buttons === 0); }
  private canReplace(a: OfficeSurfaceInputEvent, b: OfficeSurfaceInputEvent) { return a.kind === 'pointer' && b.kind === 'pointer' && a.phase === 'move' && b.phase === 'move' && a.buttons === b.buttons || a.kind === 'composition' && b.kind === 'composition' && a.phase === 'update' && b.phase === 'update' && a.compositionId === b.compositionId || a.kind === 'selection-handle' && b.kind === 'selection-handle' && a.edge === b.edge; }
  private notifyChanged() {
    const previous = this.notified, pending = this.pending, pendingEdit = this.pendingEdit;
    if (previous.pending === pending && previous.pendingEdit === pendingEdit && previous.composing === this.composing && previous.failure === this.failed) return;
    this.notified = { pending, pendingEdit, composing: this.composing, failure: this.failed };
    this.options.changed?.();
  }
  /** A long native stall may merge thousands of hover/preedit promises. Settle
   * their waiters iteratively rather than building a recursive callback chain. */
  private resolveJob(job: InputJob, value: OfficeSurfaceInputReply) {
    const resolves = job.resolves; job.resolves = []; job.rejects = [];
    for (const resolve of resolves) resolve(value);
  }
  private rejectJob(job: InputJob, error: unknown) {
    const rejects = job.rejects; job.resolves = []; job.rejects = [];
    for (const reject of rejects) reject(error);
  }
  private rejectQueued(error: unknown) {
    const jobs = this.jobs; this.jobs = []; this.queuedEdits = 0;
    for (const job of jobs) this.rejectJob(job, error);
  }
  private waiter(job:InputJob) {
    return new Promise<OfficeSurfaceInputReply>((resolve,reject)=>{job.resolves.push(resolve);job.rejects.push(reject);});
  }
  post(event: OfficeSurfaceInputEvent): Promise<OfficeSurfaceInputReply> {
    if (!this.active) return Promise.reject(new Error('Office 输入视图已关闭。'));
    if (this.failed) return Promise.reject(this.failed);
    const state=this.options.state();if(!state||state.viewId!==this.viewId)return Promise.reject(new Error('Office 输入目标未就绪。'));
    const leaseId = this.options.lease?.();
    if (this.options.lease && !leaseId) return Promise.reject(new Error('OFFICE_DISPLAY_EXPIRED'));
    const editing = this.affectsEditing(event);
    if (editing) this.editVersion++;
    if (event.kind === 'composition' && event.phase === 'start') this.composing = true;
    let changed=false,job:InputJob;
    const tail=this.jobs.at(-1);
    if(tail&&tail.leaseId===leaseId&&ownsTarget(tail.target,state)&&this.canReplace(tail.event,event)){
      job=tail;if(tail.editing!==editing){this.queuedEdits+=editing?1:-1;changed=true;}
      tail.event=event;tail.editing=editing;
    }else{
      let press: KeyPress | undefined;
      if (event.kind === 'key') {
        const physicalKey = event.code || event.key;
        if (event.phase === 'down') {
          press = event.repeat ? this.pressedKeys.get(physicalKey) : undefined;
          if (!press) {
            const previous = this.pressedKeys.get(physicalKey);
            if (previous && !previous.releaseQueued) this.acknowledgedKeys.delete(previous);
            press = { target: inputTarget(state), leaseId, releaseQueued: false };this.pressedKeys.set(physicalKey, press);
          }
        } else { press = this.pressedKeys.get(physicalKey);if (press) press.releaseQueued = true;this.pressedKeys.delete(physicalKey); }
      }
      const target = event.kind === 'key' && event.phase === 'up' && press ? { ...press.target } : inputTarget(state);
      job={event,target,leaseId,press,editing,resolves:[],rejects:[]};this.jobs.push(job);if(editing)this.queuedEdits++;changed=true;
    }
    const promise=this.waiter(job);
    if(changed)this.notifyChanged(); if(!this.sending)void this.pump(); return promise;
  }
  async barrier(): Promise<void> {
    if (this.composing) throw new Error('正在进行输入法组合输入，请完成输入后保存或修改。');
    const result = await this.post({ kind: 'barrier' });
    // Ctrl+S reaches the application before its physical Control keyup reaches
    // this FIFO. Drain that acknowledged tail instead of rejecting a valid
    // commit, and do not reissue the engine barrier or replay any edit.
    await this.idle();
    if (result.composing || this.composing) throw new Error('Office 输入尚未稳定，请完成输入后重试。');
  }
  /** Finish already captured DOM input without ending Impress' text editor. */
  async drain(): Promise<void> {
    if (this.composing) throw new Error('正在进行输入法组合输入，请先完成输入。');
    const version = this.editVersion;
    await this.idle();
    if (this.composing || version !== this.editVersion) throw new Error('输入内容仍在变化，请完成输入后重试。');
  }
  /** Impress' active Outliner owns a separate history. Send the same native
   * shortcut as typing instead of consuming a document-model undo token. */
  async history(direction: 'undo' | 'redo'): Promise<boolean> {
    await this.drain();
    const state = this.options.state();
    if (state?.format !== 'pptx' || state.inputState?.editing !== 'text') return false;
    if (state.inputState.composing || state.inputState.modal) throw new Error('请先完成中文输入或关闭原生对话框。');
    const key = direction === 'undo' ? 'z' : 'y', modifiers = { shift: false, control: true, alt: false, meta: false };
    await this.post({ kind: 'key', phase: 'down', key, code: 'Key'+key.toUpperCase(), repeat: false, modifiers });
    await this.post({ kind: 'key', phase: 'up', key, code: 'Key'+key.toUpperCase(), repeat: false, modifiers });
    await this.drain();
    return true;
  }
  /** Commit once, synchronize the authoritative model, then confirm the FIFO tail. */
  async flush(synchronizeNative: () => Promise<void>): Promise<void> {
    const version = this.editVersion;
    await this.barrier();
    if (version !== this.editVersion) throw new Error('输入内容仍在变化，请完成输入后重试。');
    await synchronizeNative();
    await this.idle();
    if (version !== this.editVersion || this.composing) throw new Error('输入内容仍在变化，请完成输入后重试。');
  }
  private idle(): Promise<void> {
    if (!this.active) return Promise.reject(new Error('Office 输入视图已关闭。'));
    if (this.failed) return Promise.reject(this.failed);
    if (!this.pending) return Promise.resolve();
    return new Promise<void>((resolve, reject) => this.idleWaiters.push({ resolve, reject }));
  }
  private settleIdle() {
    if (this.pending && this.active && !this.failed) return;
    const error = this.failed ?? (!this.active ? new Error('Office 输入视图已关闭。') : undefined);
    for (const waiter of this.idleWaiters.splice(0)) { if (error) waiter.reject(error); else waiter.resolve(); }
  }
  private async pump() {
    if (this.sending || !this.active || this.failed) return;
    const job = this.jobs.shift(); if (!job) return;
    if (job.editing) this.queuedEdits--;
    this.sending = true; this.inFlight = job;
    try {
      this.checkLease(job);
      if(!ownsTarget(job.target,this.options.state()))throw new Error('Office 输入目标的工作表、页面或会话已变化；旧输入不会自动重试。');
      await this.options.beforeInput();
      if (!this.active) throw new Error('Office 输入视图已关闭。');
      this.checkLease(job);
      const before = this.options.state(); if (!before || before.status !== 'ready') throw new Error('Office 引擎未就绪。');
      if(!ownsTarget(job.target,before))throw new Error('Office 输入目标的工作表、页面或会话已变化；旧输入不会自动重试。');
      const sequence = ++this.sequence;
      const reply = await this.options.request<OfficeSurfaceInputReply>(OFFICE_SURFACE_METHODS.input, { viewId: this.viewId, ...(job.leaseId ? { leaseId: job.leaseId } : {}), streamId: this.streamId, sequence, layoutRevision: before.layoutRevision, expectedPartIndex: job.target.partIndex, event: job.event });
      if (!this.active) throw new Error('Office 输入视图已关闭。');
      this.checkLease(job);
      const live = this.options.state();
      if (!isOfficeSurfaceState(reply.state) || reply.streamId !== this.streamId || reply.ackSequence !== sequence || reply.state.documentId !== before.documentId || reply.state.sessionId !== before.sessionId || reply.state.engineEpoch !== before.engineEpoch || reply.state.viewId !== this.viewId || live?.documentId !== before.documentId || live.viewId !== before.viewId || live.sessionId !== before.sessionId || live.engineEpoch !== before.engineEpoch) throw new Error('Office 输入回执与当前会话不匹配；输入不会自动重试。');
      if (reply.discarded && !(job.event.kind==='pointer' && job.event.phase==='move' && job.event.buttons===0 && reply.discarded.code==='STALE_OFFICE_SURFACE_LAYOUT' && typeof reply.discarded.reason==='string' && reply.discarded.reason.length>0)) throw new Error('Office 引擎丢弃了需要确认的编辑事件；输入不会自动重试。');
      this.options.accept(reply.state);
      this.confirmKey(job, before, reply.state);
      if (job.event.kind === 'composition' && ['end', 'cancel'].includes(job.event.phase)) this.composing = reply.composing;
      this.resolveJob(job, reply);
    } catch (cause) {
      this.failed = cause instanceof Error ? cause : new Error(String(cause)); this.rejectJob(job, this.failed);
      this.pressedKeys.clear(); this.acknowledgedKeys.clear();
      this.rejectQueued(this.failed);
    } finally { this.sending = false; this.inFlight = undefined; this.notifyChanged(); if (this.active && !this.failed) void this.pump(); this.settleIdle(); }
  }
  private checkLease(job: InputJob) {
    if (this.options.lease && (!job.leaseId || this.options.lease() !== job.leaseId) || job.press && job.press.leaseId !== job.leaseId) throw new Error('OFFICE_DISPLAY_EXPIRED');
  }
  private confirmKey(job: InputJob, before: OfficeSurfaceState, next: OfficeSurfaceState) {
    if (job.event.kind !== 'key' || !job.press) return;
    if (job.event.phase === 'up') { job.press.releaseQueued = false;this.acknowledgedKeys.delete(job.press);return; }
    job.press.target = inputTarget(before);
    // A lost key-up followed by another physical press must not retain an
    // orphan forever, including when this old down was still in flight.
    if (this.pressedKeys.get(job.event.code || job.event.key) === job.press || job.press.releaseQueued) this.acknowledgedKeys.add(job.press);
    if (before.partIndex === next.partIndex) return;
    // A shortcut can remove/change its own page. Only releases paired with a
    // confirmed down may follow that exact ACK; new edits retain their target.
    for (const queued of this.jobs) if (queued.event.kind === 'key' && queued.event.phase === 'up' && queued.press && this.acknowledgedKeys.has(queued.press) && queued.leaseId === job.leaseId && ownsTarget(queued.target, before) && ownsTarget(queued.press.target, before)) queued.target = inputTarget(next);
    for (const press of this.acknowledgedKeys) if (press.leaseId === job.leaseId && ownsTarget(press.target, before)) press.target = inputTarget(next);
  }
  dispose() { this.active = false; this.pressedKeys.clear(); this.acknowledgedKeys.clear(); this.rejectQueued(new Error('Office 输入视图已关闭。')); this.settleIdle(); }
}
