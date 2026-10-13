import type { NativeOfficeFormat, NativeOfficeStyleTarget, NativeOfficeStyleValues } from '../../../../../packages/contracts/src/native-office';
import { nativeOfficeStylePatchSchema } from '../../../../../packages/contracts/src/native-office';
import type { OfficeToolboxCategory } from '../components/office/toolbox-contributions';

export type NativeStyleControl = { name: string; label: string; kind: 'text' | 'number' | 'boolean' | 'color' | 'select'; group: string; unit?: string; min?: number; max?: number; maxLength?: number; options?: readonly [string, string][] };
const font: NativeStyleControl[] = [
  { name: 'fontFamily', label: '字体', kind: 'text', maxLength: 100, group: '字体' }, { name: 'fontSize', label: '字号', kind: 'number', unit: 'pt', min: 1, max: 400, group: '字体' },
  ...[['bold','粗体'],['italic','斜体'],['underline','下划线'],['strike','删除线']].map(([name,label]) => ({ name, label, kind: 'boolean' as const, group: '字体' })),
  { name: 'color', label: '文字颜色', kind: 'color', group: '字体' }, { name: 'highlight', label: '文字底色', kind: 'color', group: '字体' },
];
const alignment: NativeStyleControl = { name: 'alignment', label: '对齐', kind: 'select', group: '对齐', options: [['left','左对齐'],['center','居中'],['right','右对齐'],['justify','两端对齐']] };
const paragraph: NativeStyleControl[] = [alignment, ...[['left','左缩进'],['right','右缩进'],['firstLine','首行缩进'],['top','段前'],['bottom','段后']].map(([name,label]) => ({ name, label, kind: 'number' as const, group: '缩进与间距', unit: 'mm', min: name === 'firstLine' ? -1000 : 0, max: 1000 })), { name:'lineSpacingPercent',label:'行距',kind:'number',group:'缩进与间距',unit:'%',min:50,max:500 }];
const cells: NativeStyleControl[] = [...font, alignment, { name:'verticalAlignment',label:'垂直对齐',kind:'select',group:'对齐',options:[['top','顶端'],['center','居中'],['bottom','底端']] }, {name:'wrap',label:'自动换行',kind:'boolean',group:'对齐'}, {name:'fill',label:'填充',kind:'color',group:'填充与数字'}, {name:'numberFormat',label:'数字格式代码',kind:'text',maxLength:120,group:'填充与数字'}];
const shape: NativeStyleControl[] = [...[['x','横向位置'],['y','纵向位置'],['width','宽度'],['height','高度']].map(([name,label])=>({name,label,kind:'number' as const,group:'位置与尺寸',unit:'mm',min:(name === 'width' || name === 'height') ? 0.01 : -10000,max:10000})), {name:'rotation',label:'旋转',kind:'number',group:'位置与尺寸',unit:'°',min:-360,max:360}, {name:'fill',label:'填充',kind:'color',group:'外观'}, {name:'lineColor',label:'边框颜色',kind:'color',group:'外观'}, {name:'lineWidth',label:'边框宽度',kind:'number',group:'外观',unit:'pt',min:0,max:30}];
const controls: Record<NativeOfficeStyleTarget, readonly NativeStyleControl[]> = { text: font, paragraph, cells, shape };
export const nativeStyleControls = (target: NativeOfficeStyleTarget) => controls[target];
export function nativeStyleTargets(format: NativeOfficeFormat, category: OfficeToolboxCategory): NativeOfficeStyleTarget[] {
  return format==='docx' ? category==='home'?['text','paragraph']:category==='layout'?['paragraph']:[] : format==='xlsx' ? category==='home'?['cells']:[] : category==='home'?['text']:category==='arrange'?['shape']:[];
}
/** Only explicitly changed, validated primitives can enter a native style transaction. */
export function parseNativeStyleValues(target: NativeOfficeStyleTarget, draft: Record<string, string | boolean>): NativeOfficeStyleValues {
  const result: Record<string, string | number | boolean> = {};
  for (const [name,value] of Object.entries(draft)) {
    const control = controls[target].find(item=>item.name===name); if(!control) throw new Error('不属于当前目标的属性。');
    if(control.kind==='boolean') { if(typeof value!=='boolean') throw new Error(control.label+'需要开关值。'); result[name]=value; }
    else if(typeof value!=='string') throw new Error(control.label+'格式无效。');
    else if(control.kind==='number') { const number=Number(value); if(!value.trim()||!Number.isFinite(number)||number<(control.min??-Infinity)||number>(control.max??Infinity))throw new Error(control.label+'超出有效范围。'); result[name]=number; }
    else if(control.kind==='color') { const color=value.replace(/^#/,''); if(!/^[0-9a-f]{6}$/i.test(color))throw new Error(control.label+'需要六位颜色值。'); result[name]=color.toUpperCase(); }
    else if(control.kind==='select') { if(!control.options?.some(item=>item[0]===value))throw new Error(control.label+'选项无效。'); result[name]=value; }
    else { if(!value.trim()||value.length>(control.maxLength ?? 1000))throw new Error(control.label+'不能为空或过长。'); result[name]=value; }
  }
  if(!Object.keys(result).length)throw new Error('尚未修改属性。');
  return nativeOfficeStylePatchSchema.parse({ target, values: result }).values;
}

export function nativeStyleReplacedCommands(targets: readonly NativeOfficeStyleTarget[]) {
  const names = new Set<string>();
  if(targets.some(target=>target==='text'||target==='cells')) for(const name of ['Bold','Italic','Underline','Strikeout','FontDialog'])names.add('.uno:'+name);
  if(targets.includes('paragraph'))for(const name of ['LeftPara','CenterPara','RightPara','JustifyPara','ParagraphDialog'])names.add('.uno:'+name);
  if(targets.includes('cells'))for(const name of ['AlignLeft','AlignHorizontalCenter','AlignRight','WrapText','FormatCellDialog','NumberFormatCurrency','NumberFormatPercent'])names.add('.uno:'+name);
  if(targets.includes('shape'))names.add('.uno:TransformDialog');
  return names;
}
