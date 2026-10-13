import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { nativeOfficeAccessibilitySource } from '../packages/office-runtime/src/accessibility-source';

const python = process.env.AGENTVIEWER_NATIVE_PYTHON ?? join(process.env.LOCALAPPDATA ?? '', 'Programs', 'AgentViewer', 'resources', 'engines', 'libreoffice', 'program', 'python.exe');

/** Execute the shipped Python helpers themselves. Loading oleacc is not a UI action;
 * no window, document, accessible object or installed app is opened by these tests. */
function evaluate(expression: string) {
  return JSON.parse(execFileSync(python, ['-c', 'import json,sys;scope={};exec(sys.stdin.read(),scope);print(json.dumps(eval(sys.argv[1],scope)))', expression], { input: nativeOfficeAccessibilitySource, encoding: 'utf8', windowsHide: true }));
}
const unavailable = process.platform !== 'win32' || !existsSync(python);

test('native accessibility accepts only the explicitly validated coordinate scale, never falls back to Windows DPI', { skip: unavailable }, () => {
  assert.deepEqual(evaluate("[_a_coordinate_scale(v) for v in [{}, {'coordinateScale':None}, {'coordinateScale':True}, {'coordinateScale':'1.5'}, {'coordinateScale':0}, {'coordinateScale':-1}, {'coordinateScale':float('nan')}, {'coordinateScale':float('inf')}, {'coordinateScale':float('-inf')}, {'coordinateScale':1}, {'coordinateScale':1.5}, {'coordinateScale':2}]]"), [null, null, null, null, null, null, null, null, null, 1, 1.5, 2]);
});

test('actual accessibility rectangle normalization uses renderer scale including non-DPI factors and relocated origins', { skip: unavailable }, () => {
  const boxes = evaluate("[_a_css_rect((160,240,90,45),(100,150),_a_coordinate_scale({'coordinateScale':scale})) for scale in [1,1.5,2,2.5]]");
  assert.deepEqual(boxes, [
    { x: 60, y: 90, width: 90, height: 45 },
    { x: 40, y: 60, width: 60, height: 30 },
    { x: 30, y: 45, width: 45, height: 22.5 },
    { x: 24, y: 36, width: 36, height: 18 },
  ]);
  assert.deepEqual(evaluate("_a_css_rect((-1540,340,90,45),(-1600,250),1.5)"), boxes[1], 'moving an owned window to a display with negative screen coordinates does not change the CSS selection rectangle');
});

test('missing coordinate metadata returns unavailable before touching accessibility or a native HWND', { skip: unavailable }, () => {
  assert.deepEqual(evaluate("native_accessibility({'hwnd':999,'visible':True})"), ['', false, false, null, false]);
});
