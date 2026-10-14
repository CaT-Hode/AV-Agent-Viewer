import { OFFICE_SURFACE_METHODS, isOfficeSurfaceState, type OfficeSurfaceInputEvent, type OfficeSurfaceInputReply, type OfficeSurfaceState } from '../../../../../packages/contracts/src/office-surface';
import type { NativeOfficeRequest } from './native-office-tools';

type InputTarget = Pick<OfficeSurfaceState, 'documentId'|'viewId'|'sessionId'|'engineEpoch'|'partIndex'>;
type InputJob = { event: OfficeSurfaceInputEvent; target: InputTarget; resolve(value: OfficeSurfaceInputReply): void; reject(error: unknown): void };
const inputTarget = (state: OfficeSurfaceState): InputTarget => ({ documentId:state.documentId,viewId:state.viewId,sessionId:state.sessionId,engineEpoch:state.engineEpoch,partIndex:state.partIndex });
const ownsTarget = (target: InputTarget, live?: OfficeSurfaceState) => !!live && target.documentId===live.documentId && target.viewId===live.viewId && target.sessionId===live.sessionId && target.engineEpoch===live.engineEpoch && target.partIndex===live.partIndex;
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
  private idleWaiters: { resolve(): void; reject(error: unknown): void }[] = [];
  private composing = false;
  constructor(readonly viewId: string, private options: { request: NativeOfficeRequest; state(): OfficeSurfaceState | undefined; beforeInput(): Promise<void>; accept(state: OfficeSurfaceState): void; changed?(): void }) {}
  get pending() { return this.sending || this.jobs.length > 0; }
  /** A physical release/hover needs an acknowledgement, but is not an unsaved edit. */
  get pendingEdit() { return !!this.inFlight && this.affectsEditing(this.inFlight.event) || this.jobs.some(job => this.affectsEditing(job.event)); }
  get compositionActive() { return this.composing; }
  get failure() { return this.failed; }
  private affectsEditing(event: OfficeSurfaceInputEvent) { return event.kind !== 'barrier' && !(event.kind === 'key' && (event.phase === 'up' || ['Control','Shift','Alt','Meta'].includes(event.key))) && !(event.kind === 'pointer' && event.phase === 'move' && event.buttons === 0); }
  private canReplace(a: OfficeSurfaceInputEvent, b: OfficeSurfaceInputEvent) { return a.kind === 'pointer' && b.kind === 'pointer' && a.phase === 'move' && b.phase === 'move' && a.buttons === b.buttons || a.kind === 'composition' && b.kind === 'composition' && a.phase === 'update' && b.phase === 'update' && a.compositionId === b.compositionId || a.kind === 'selection-handle' && b.kind === 'selection-handle' && a.edge === b.edge; }
  post(event: OfficeSurfaceInputEvent): Promise<OfficeSurfaceInputReply> {
    if (!this.active) return Promise.reject(new Error('Office 输入视图已关闭。'));
    if (this.failed) return Promise.reject(this.failed);
    const state=this.options.state();if(!state||state.viewId!==this.viewId)return Promise.reject(new Error('Office 输入目标未就绪。'));
    const target=inputTarget(state);
    if (this.affectsEditing(event)) this.editVersion++;
    if (event.kind === 'composition' && event.phase === 'start') this.composing = true;
    const promise = new Promise<OfficeSurfaceInputReply>((resolve, reject) => {
      const tail = this.jobs.at(-1);
      if (tail && ownsTarget(tail.target,state) && this.canReplace(tail.event, event)) {
        const originalResolve = tail.resolve, originalReject = tail.reject; tail.event = event;
        tail.resolve = value => { originalResolve(value); resolve(value); }; tail.reject = error => { originalReject(error); reject(error); };
      } else this.jobs.push({ event, target, resolve, reject });
    });
    this.options.changed?.(); void this.pump(); return promise;
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
    this.sending = true; this.inFlight = job;
    try {
      if(!ownsTarget(job.target,this.options.state()))throw new Error('Office 输入目标的工作表、页面或会话已变化；旧输入不会自动重试。');
      await this.options.beforeInput();
      if (!this.active) throw new Error('Office 输入视图已关闭。');
      const before = this.options.state(); if (!before || before.status !== 'ready') throw new Error('Office 引擎未就绪。');
      if(!ownsTarget(job.target,before))throw new Error('Office 输入目标的工作表、页面或会话已变化；旧输入不会自动重试。');
      const sequence = ++this.sequence;
      const reply = await this.options.request<OfficeSurfaceInputReply>(OFFICE_SURFACE_METHODS.input, { viewId: this.viewId, streamId: this.streamId, sequence, layoutRevision: before.layoutRevision, expectedPartIndex: job.target.partIndex, event: job.event });
      if (!this.active) throw new Error('Office 输入视图已关闭。');
      const live = this.options.state();
      if (!isOfficeSurfaceState(reply.state) || reply.streamId !== this.streamId || reply.ackSequence !== sequence || reply.state.sessionId !== before.sessionId || reply.state.engineEpoch !== before.engineEpoch || reply.state.viewId !== this.viewId || live?.sessionId !== before.sessionId || live.engineEpoch !== before.engineEpoch) throw new Error('Office 输入回执与当前会话不匹配；输入不会自动重试。');
      if (reply.discarded && !(job.event.kind==='pointer' && job.event.phase==='move' && job.event.buttons===0 && reply.discarded.code==='STALE_OFFICE_SURFACE_LAYOUT' && typeof reply.discarded.reason==='string' && reply.discarded.reason.length>0)) throw new Error('Office 引擎丢弃了需要确认的编辑事件；输入不会自动重试。');
      this.options.accept(reply.state);
      if (job.event.kind === 'composition' && ['end', 'cancel'].includes(job.event.phase)) this.composing = reply.composing;
      job.resolve(reply);
    } catch (cause) {
      this.failed = cause instanceof Error ? cause : new Error(String(cause)); job.reject(this.failed);
      for (const waiting of this.jobs.splice(0)) waiting.reject(this.failed);
    } finally { this.sending = false; this.inFlight = undefined; this.options.changed?.(); if (this.active && !this.failed) void this.pump(); this.settleIdle(); }
  }
  dispose() { this.active = false; for (const job of this.jobs.splice(0)) job.reject(new Error('Office 输入视图已关闭。')); this.settleIdle(); }
}
