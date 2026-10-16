let loading: Promise<typeof import('gemoji')> | undefined;
let names: Record<string, string> | undefined;
export function loadMarkdownEmoji() { loading ??= import('gemoji').then(module => { names = module.nameToEmoji; return module; }).catch(error => { loading = undefined; throw error; }); return loading; }
export function markdownEmoji(name: string) { return names?.[name]; }
