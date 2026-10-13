import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGlassElasticController, glassElasticMotionEnabled, glassElasticTarget, glassMaterialTarget, glassSpringParameters, sampleGlassDragAxis, stepGlassSpring } from '../apps/desktop/src/renderer/lib/glass-elasticity';
import { KUBE_GLASS_SPRINGS } from '../apps/desktop/src/renderer/lib/glass-presets';

test('a release spring settles and a reversal preserves the current velocity', () => {
  let axis = { value: 1.03, velocity: 0 };
  const parameters = { stiffness: 340, damping: 20 };
  let smallest = Infinity;
  for (let frame = 0; frame < 100; frame++) { axis = stepGlassSpring(axis, .82, 1 / 60, parameters); smallest = Math.min(smallest, axis.value); }
  assert.ok(smallest < .82, 'the release has a damped return rather than a fixed easing tween');
  assert.ok(Math.abs(axis.value - .82) < .00001 && Math.abs(axis.velocity) < .0001);
  const moving = stepGlassSpring({ value: 1.01, velocity: -.4 }, .82, 1 / 120, parameters);
  const reversed = stepGlassSpring(moving, 1.03, 1 / 120, parameters);
  assert.ok(Number.isFinite(reversed.value) && Number.isFinite(reversed.velocity));
  assert.ok(Math.abs(reversed.value - moving.value) < .01, 'retargeting does not jump to either endpoint');
});

test('critical/overdamped steps and suspended frames remain finite', () => {
  for (const damping of [0, 40, 80]) {
    const result = stepGlassSpring({ value: .82, velocity: 0 }, 1.03, 20, { stiffness: 400, damping });
    assert.ok(Number.isFinite(result.value) && Number.isFinite(result.velocity));
    assert.ok(result.value > .82 && result.value < 1.25);
  }
  const axis = { value: .9, velocity: .2 }; assert.equal(stepGlassSpring(axis, 1, 0, { stiffness: 340, damping: 20 }), axis);
});

test('source search, switch and slider scales remain separate from material fill', () => {
  assert.equal(glassElasticTarget('switch', false).scaleX, .65); assert.equal(glassElasticTarget('switch', true).scaleX, .9);
  assert.equal(glassElasticTarget('slider', false).scaleX, .6); assert.equal(glassElasticTarget('slider', true).scaleX, 1);
  assert.equal(glassElasticTarget('search', false).scaleX, .8);
  assert.equal(glassElasticTarget('search', false, { x: 0, y: 0 }, true).scaleX, 1);
  assert.equal(glassElasticTarget('search', true, { x: 0, y: 0 }, true).scaleX, .99);
  assert.deepEqual(glassMaterialTarget('switch', false), { fill: 1, refraction: .4, magnification: 24 });
  assert.deepEqual(glassMaterialTarget('switch', true), { fill: .1, refraction: .9, magnification: 24 });
  assert.equal(glassMaterialTarget('search', true, true).fill, .3);
  assert.equal(glassMaterialTarget('search', false, true).fill, .2);
});

test('source magnifier uses horizontal speed and a 0.7 compression floor', () => {
  const horizontal = glassElasticTarget('lens', true, { x: 9000, y: 0 }), vertical = glassElasticTarget('lens', true, { x: 0, y: -9000 });
  assert.deepEqual(horizontal, { scaleX: 1.3, scaleY: .7, x: 0, y: 0 });
  assert.deepEqual(vertical, { scaleX: 1, scaleY: 1, x: 0, y: 0 });
  assert.deepEqual(glassElasticTarget('lens', false), { scaleX: 1, scaleY: .8, x: 0, y: 0 });
  assert.equal(glassMaterialTarget('lens', true).magnification, 48);
  assert.equal(glassMaterialTarget('lens', false).magnification, 24);
});

test('reduced/off preferences disable physical motion without changing semantics', () => {
  assert.equal(glassElasticMotionEnabled('standard', false), true);
  assert.equal(glassElasticMotionEnabled('elegant', false), true);
  assert.equal(glassElasticMotionEnabled('elegant', true), false);
  assert.equal(glassElasticMotionEnabled('standard', true), false);
  assert.equal(glassElasticMotionEnabled('reduced', false), false);
  assert.equal(glassElasticMotionEnabled('off', false), false);
});

test('elegant press is softer/slower with restrained overshoot and interruptible reversal', () => {
  const source = { ...KUBE_GLASS_SPRINGS.searchScale }, standard = glassSpringParameters(source,'standard'), elegant = glassSpringParameters(source,'elegant');
  assert.deepEqual(source,KUBE_GLASS_SPRINGS.searchScale,'the audited source parameters are immutable');
  const target=glassElasticTarget('button',true,{x:0,y:0},false,'elegant').scaleX;
  assert.equal(target,.9,'the source Music button press is visible in both animated modes');
  assert.ok(elegant.stiffness<standard.stiffness);
  let axis={value:1,velocity:0},minimum=1,settledAt=0;
  for(let frame=1;frame<=120;frame++){
    axis=stepGlassSpring(axis,target,1/120,elegant);minimum=Math.min(minimum,axis.value);
    if(!settledAt&&Math.abs(axis.value-target)<.0004&&Math.abs(axis.velocity)<.003)settledAt=frame/120;
  }
  assert.ok(minimum<target&&minimum>target-(1-target)*.04,'overshoot stays below 4% of the source press excursion');
  assert.ok(settledAt>=.35&&settledAt<=.8,'elegant shape has a slower finite settle');
  const moving=stepGlassSpring({value:.985,velocity:-.1},target,1/120,elegant);
  const released=stepGlassSpring(moving,1,1/120,elegant);
  assert.ok(Math.abs(released.value-moving.value)<Math.abs(moving.velocity)/120+.0001,'release displacement is bounded by the inherited incoming velocity while it decelerates');
  assert.ok(released.velocity<0,'the reversal inherits incoming velocity before returning');
});

test('direct pointer tracking samples release velocity without a position spring',()=>{
  const first=sampleGlassDragAxis({value:5,velocity:0},17,16);
  assert.equal(first.value,17);assert.equal(first.velocity,500);
  const reverse=sampleGlassDragAxis(first,13,16);assert.equal(reverse.velocity,-250);
  const suspended=sampleGlassDragAxis(reverse,10,500);assert.deepEqual(suspended,{value:10,velocity:0});
  const released=stepGlassSpring(reverse,0,1/120,glassSpringParameters(KUBE_GLASS_SPRINGS.switchPosition,'elegant'));
  assert.ok(released.value<reverse.value&&released.value>0,'release moves continuously in the measured direction');
});

test('turning motion off during an elegant press stops RAF and releases will-change',()=>{
  const names=['window','document','HTMLElement','requestAnimationFrame','cancelAnimationFrame','performance'] as const;
  const original=new Map(names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  let now=0,id=0;const frames=new Map<number,FrameRequestCallback>(),properties=new Map<string,string>();
  class FakeElement{
    dataset:Record<string,string>={};
    classList={contains:(name:string)=>this.classes.has(name),add:(name:string)=>{this.classes.add(name);},remove:(name:string)=>{this.classes.delete(name);}};
    classes=new Set<string>();
    style={getPropertyValue:(name:string)=>properties.get(name)??'',getPropertyPriority:()=>'',setProperty:(name:string,value:string)=>{properties.set(name,value);},removeProperty:(name:string)=>{properties.delete(name);}};
    closest(){return null;}querySelectorAll(){return [];}
    getAttribute(name:string){return name==='data-glass-elastic-state'?this.dataset.glassElasticState??null:null;}
    setAttribute(name:string,value:string){if(name==='data-glass-elastic-state')this.dataset.glassElasticState=value;}
    removeAttribute(name:string){if(name==='data-glass-elastic-state')delete this.dataset.glassElasticState;}
  }
  const mode={motion:'elegant'},element=new FakeElement();properties.set('will-change','color');
  const globals={window:{matchMedia:()=>({matches:false})},document:{documentElement:{dataset:mode}},HTMLElement:FakeElement,requestAnimationFrame:(callback:FrameRequestCallback)=>{const next=++id;frames.set(next,callback);return next;},cancelAnimationFrame:(handle:number)=>{frames.delete(handle);},performance:{now:()=>now}};
  for(const name of names)Object.defineProperty(globalThis,name,{value:globals[name],configurable:true,writable:true});
  const advance=()=>{now+=1000/60;const pending=[...frames.values()];frames.clear();for(const callback of pending)callback(now);};
  try{
    const controller=createGlassElasticController(element as unknown as HTMLElement);
    controller.pointerDown({pointerId:1,clientX:0,clientY:0,timeStamp:now,isPrimary:true,button:0});
    assert.equal(element.dataset.glassElasticState,'press');assert.equal(properties.get('will-change'),'scale, translate');
    let preceding=Number(properties.get('--glass-elastic-scale-x'));
    for(let frame=0;frame<6;frame++){preceding=Number(properties.get('--glass-elastic-scale-x'));advance();}
    assert.ok(Number(properties.get('--glass-elastic-scale-x'))<.99,'elegant actually animates instead of falling through to reduced');
    const before=Number(properties.get('--glass-elastic-scale-x'));controller.pointerUp({pointerId:1});
    assert.equal(Number(properties.get('--glass-elastic-scale-x')),before,'release retargets without jumping at the input event');
    advance();const released=Number(properties.get('--glass-elastic-scale-x'));
    assert.ok(released<before,'release initially inherits the real incoming downwards velocity');
    assert.ok(Math.abs(released-before)<Math.abs(before-preceding),'the first release frame decelerates instead of snapping to either endpoint');
    mode.motion='off';advance();
    assert.equal(frames.size,0);assert.equal(properties.get('will-change'),'color');assert.equal(properties.get('--glass-elastic-scale-x'),'1.00000');
    controller.pointerDown({pointerId:2,clientX:0,clientY:0,timeStamp:now});assert.equal(frames.size,0);
    controller.destroy();assert.equal(properties.get('will-change'),'color');assert.equal(properties.has('--glass-elastic-scale-x'),false);
  }finally{for(const name of names){const descriptor=original.get(name);if(descriptor)Object.defineProperty(globalThis,name,descriptor);else Reflect.deleteProperty(globalThis,name);}}
});
