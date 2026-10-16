import { stepGlassSpring, type SpringAxis, type SpringParameters } from './glass-elasticity';
import { constrainSelectionToolbar, selectionToolbarFits, selectionToolbarRoute, selectionToolbarSegmentClear, type SelectionToolbarPosition, type SelectionToolbarScene } from './selection-position';

/** Interruptible two-dimensional spring with a hard collision constraint.
 * A panel growing underneath the old pose projects it out immediately: visual
 * elasticity must never let the toolbar lag behind and become unclickable. */
export class SelectionToolbarMotion {
  private x: SpringAxis = { value: 0, velocity: 0 };
  private y: SpringAxis = { value: 0, velocity: 0 };
  private pose?: SelectionToolbarPosition;
  private path: SelectionToolbarPosition[] = [];
  private scene?: SelectionToolbarScene;
  private signature = '';
  private identity: unknown;
  get position() { return this.pose; }
  get moving() { return this.path.length > 0; }
  reset() { this.pose = undefined; this.path = []; this.scene = undefined; this.signature = ''; }
  retarget(target: SelectionToolbarPosition | undefined, scene: SelectionToolbarScene, identity: unknown, animate = true) {
    if (!target || !selectionToolbarFits(target, scene)) { this.reset(); return; }
    const signature = JSON.stringify([target, scene]);
    if (this.pose && this.identity === identity && signature === this.signature && animate) return this.pose;
    this.signature = signature; this.scene = scene;
    const before = this.pose, fresh = !before || this.identity !== identity || !animate; this.identity = identity;
    if (fresh) { this.pose = { ...target }; this.x = { value: target.x, velocity: 0 }; this.y = { value: target.y, velocity: 0 }; this.path = []; return this.pose; }
    const projected = constrainSelectionToolbar({ x: before.x, y: before.y, width: target.width }, scene);
    if (!projected) { this.reset(); return; }
    if (projected.x !== before.x) this.x = { value: projected.x, velocity: 0 };
    if (projected.y !== before.y) this.y = { value: projected.y, velocity: 0 };
    this.pose = projected;
    const route = selectionToolbarRoute(projected, target, scene);
    // Disconnected legal regions cannot be crossed without a collision. Move
    // directly into the valid region rather than drawing through an obstacle.
    if (!route) { this.pose = { ...target }; this.x = { value: target.x, velocity: 0 }; this.y = { value: target.y, velocity: 0 }; this.path = []; return this.pose; }
    this.path = Math.hypot(projected.x - target.x, projected.y - target.y) < .05 && Math.hypot(this.x.velocity, this.y.velocity) < .1 ? [] : route;
    return this.pose;
  }
  step(seconds: number, parameters: SpringParameters) {
    const current = this.pose, waypoint = this.path[0], scene = this.scene;
    if (!current || !waypoint || !scene) return current;
    const x = stepGlassSpring(this.x, waypoint.x, seconds, parameters), y = stepGlassSpring(this.y, waypoint.y, seconds, parameters);
    const proposed = { x: x.value, y: y.value, width: current.width }, safe = constrainSelectionToolbar(proposed, scene);
    if (!safe) { this.reset(); return; }
    let next = safe;
    if (!selectionToolbarSegmentClear(current, safe, scene)) next = waypoint;
    this.x = { value: next.x, velocity: Math.abs(next.x - proposed.x) < 1e-6 ? x.velocity : 0 };
    this.y = { value: next.y, velocity: Math.abs(next.y - proposed.y) < 1e-6 ? y.velocity : 0 };
    this.pose = next;
    if (Math.hypot(next.x - waypoint.x, next.y - waypoint.y) < .15 && Math.hypot(this.x.velocity, this.y.velocity) < 1) {
      this.pose = { ...waypoint }; this.x.value = waypoint.x; this.y.value = waypoint.y; this.path.shift();
      if (!this.path.length) { this.x.velocity = 0; this.y.velocity = 0; }
    }
    return this.pose;
  }
}
