import type { MarkdownCommandName } from '../../../../../packages/markdown/src/commands';
export const editingKeys: [string, MarkdownCommandName][] = [
  ['Mod-b', 'bold'], ['Mod-i', 'italic'], ['Mod-u', 'underline'], ['Alt-Shift-5', 'strike'], ['Mod-Shift-`', 'code'],
  ['Mod-k', 'link'], ['Mod-Shift-i', 'image'], ['Mod-Shift-k', 'codeBlock'], ['Mod-Shift-m', 'mathBlock'], ['Mod-Shift-q', 'quote'],
  ['Mod-Shift-[', 'ordered'], ['Mod-Shift-]', 'bullet'], ['Mod-t', 'table'], ['Mod-\\', 'clear'],
  ...Array.from({ length: 7 }, (_, level) => ['Mod-' + level, 'heading' + level] as [string, MarkdownCommandName]),
];
export const inheritedKeys: Record<string, string[]> = { undo: ['Mod-z'], redo: ['Mod-y', 'Mod-Shift-z'], find: ['Mod-f'], replace: ['Mod-h'] };


const defaults: [string,string][] = [
  ...editingKeys, ...Object.entries(inheritedKeys).flatMap(([cmd,keys])=>keys.map(key=>[key,cmd] as [string,string])),
  ['F8','focus'], ['F9','typewriter'],
];

function matches(binding:string,event:KeyboardEvent) {
  const parts=binding.toLowerCase().split('-'),key=parts.pop();
  const mod=parts.includes('mod'),mac=/Mac/.test(navigator.platform);
  if((parts.includes('ctrl')||parts.includes('control')||mod&&!mac)!==event.ctrlKey||
     (parts.includes('meta')||parts.includes('cmd')||mod&&mac)!==event.metaKey||
     parts.includes('alt')!==event.altKey||parts.includes('shift')!==event.shiftKey)return false;
  return key===event.key.toLowerCase() || !!key&&event.shiftKey&&(
    event.code==='Digit'+key||({'[':'BracketLeft',']':'BracketRight','`':'Backquote'} as Record<string,string>)[key]===event.code);
}

export function markdownShortcut(event:KeyboardEvent,overrides:Record<string,string>) {
  for(const [cmd,binding] of Object.entries(overrides))if(binding&&matches(binding,event))return cmd;
  return defaults.find(([binding,cmd])=>!Object.hasOwn(overrides,cmd)&&matches(binding,event))?.[1];
}
