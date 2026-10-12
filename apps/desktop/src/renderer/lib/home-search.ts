import type { DocumentInfo } from '../../../../../packages/contracts/src/index';
import type { TranslationArtifact } from '../../../../../packages/translation/src/index';

export type HomeQueryResult =
  | { kind: 'empty' | 'search'; text: string }
  | { kind: 'url'; text: string; url: string }
  | { kind: 'file'; text: string; path: string }
  | { kind: 'invalid'; text: string; reason: string };
export type HomeSearchSource = 'document' | 'sample' | 'translation';
export type HomeSearchCandidate = {
  key: string; source: HomeSearchSource; sources: HomeSearchSource[];
  title: string; format: string; path?: string; documentId?: string;
  artifactId?: string; sourceTitle?: string; targetLanguage?: string;
  /** Metadata aliases retained when one file appears in multiple collections. */
  searchTerms?: string[];
};
export type HomeSearchSources = {
  documents?: readonly Pick<DocumentInfo, 'id' | 'title' | 'format' | 'path'>[];
  samples?: readonly { name: string; format: string; path: string }[];
  artifacts?: readonly Pick<TranslationArtifact, 'id' | 'sourceTitle' | 'targetLanguage' | 'format' | 'path' | 'documentId'>[];
};
export type RankedHomeSearchCandidate = HomeSearchCandidate & { score: number };

// Conservative address inference is a product policy, not a public-suffix
// database. Unknown suffixes require an explicit http(s) URL. Document suffixes
// win over country/domain inference, e.g. notes.md is a filename search.
const bareDomainSuffixes = new Set(('com org net edu gov mil int io dev app ai cn co me info biz xyz online tech site cloud tools work page link wiki blog live store shop cc tv us uk de fr jp ca au nz in sg hk tw ch se no nl it es ru br za kr mx eu id fi dk be at pl pt ie il ae sa tr ua local localhost xn--fiqs8s xn--fiqz9s').split(' '));
const documentSuffixes = new Set(('md markdown pdf doc docx ppt pptx xls xlsx xlsm xlsb xltx xltm epub html htm txt rtf odt ods odp csv tsv json yaml yml xml toml ini log png jpg jpeg gif svg webp bmp ico zip').split(' '));
const blockedSchemes = /^(?:javascript|data|file|vbscript|mailto|tel|ftp|about|chrome|edge|view-source):/i;
const controls = /[\u0000-\u001f\u007f]/;
const fold = (value: string) => value.normalize('NFKC').toLowerCase();
const filename = (value: string) => value.split(/[\\/]/).filter(Boolean).at(-1) ?? value;
const suffix = (value: string) => value.split('.').at(-1)?.toLowerCase() ?? '';

function unquote(value: string): string { return value.length >= 2 && ((value[0] === '"' && value.at(-1) === '"') || (value[0] === "'" && value.at(-1) === "'")) ? value.slice(1, -1) : value; }
function localPath(value: string): boolean {
  return /^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value) || /^\.{1,2}[\\/]/.test(value) || /^\/(?!\/)/.test(value) || /^~[\\/]/.test(value)
    || (value.includes('\\') && !/^[a-z][\w+.-]*:/i.test(value))
    || (/^[^/:?#]+\/.+/.test(value) && !value.split('/')[0].includes('.') && documentSuffixes.has(suffix(filename(value))));
}
function parsedAddress(value: string, explicit: boolean): string | undefined {
  if (/\s|\\/.test(value)) return;
  let url: URL;
  try { url = new URL(explicit ? value : 'https:' + (value.startsWith('//') ? value : '//' + value)); } catch { return; }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const ipv6 = host.startsWith('[') && host.endsWith(']');
  const ipv4 = /^\d+\.\d+\.\d+\.\d+$/.test(host);
  const local = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local');
  if (!ipv6 && !ipv4 && (!host.split('.').every(label => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label)) || host.length > 253)) return;
  if (!explicit) {
    // Do not let URL's permissive numeric-host normalization turn 127.1 or a
    // hex integer into an inferred address. Bracketed IPv6 is unambiguous.
    const writtenHost = value.replace(/^\/\//, '').split(/[/?#]/)[0].split(':')[0].replace(/\.$/, '');
    if (ipv4 && !/^\d+\.\d+\.\d+\.\d+$/.test(writtenHost)) return;
    if (!ipv6 && !ipv4 && !local && (host.split('.').length < 2 || documentSuffixes.has(suffix(host)) || !bareDomainSuffixes.has(suffix(host)))) return;
    if (ipv6 || ipv4 || local) url.protocol = 'http:';
  }
  return url.href;
}

export function classifyHomeQuery(input: string): HomeQueryResult {
  const text = input.trim();
  if (!text) return { kind: 'empty', text };
  if (controls.test(input)) return { kind: 'invalid', text, reason: '输入包含不可用的控制字符。' };
  const value = unquote(text);
  if (blockedSchemes.test(value)) return { kind: 'invalid', text, reason: '这里只支持 http、https 网页或明确的本地文件路径。' };
  if (/^https?:/i.test(value)) {
    const url = /^https?:\/\//i.test(value) ? parsedAddress(value, true) : undefined;
    return url ? { kind: 'url', text, url } : { kind: 'invalid', text, reason: '网页地址无效，或包含凭据、反斜线、未转义空白。' };
  }
  // A bare IPv6 literal without a port may be pasted as ::1 or 2001:db8::1.
  if (/^[a-f\d:]+$/i.test(value) && value.includes('::')) {
    const url = parsedAddress('[' + value + ']', false);
    if (url) return { kind: 'url', text, url };
  }
  const address = parsedAddress(value, false);
  if (address) return { kind: 'url', text, url: address };
  if (localPath(value) || value.startsWith('//')) return { kind: 'file', text, path: value };
  if (/^[a-z][\w+.-]*:\/\//i.test(value)) return { kind: 'invalid', text, reason: '网页导航只支持 http 和 https。' };
  return { kind: 'search', text };
}

/** Windows file identity, kept separate from the looser Unicode search fold. */
function pathKey(value: string): string {
  const normalized = value.replaceAll('\\', '/'), prefix = normalized.startsWith('//') ? '//' : normalized.startsWith('/') ? '/' : '';
  const parts: string[] = [];
  for (const part of normalized.slice(prefix.length).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && parts.length && parts.at(-1) !== '..' && !/^[a-z]:$/i.test(parts.at(-1)!)) parts.pop(); else parts.push(part);
  }
  return (prefix + parts.join('/')).toLowerCase();
}
const priority: Record<HomeSearchSource, number> = { document: 3, translation: 2, sample: 1 };
function mergeCandidate(first: HomeSearchCandidate, second: HomeSearchCandidate): HomeSearchCandidate {
  const primary = priority[first.source] >= priority[second.source] ? first : second, other = primary === first ? second : first;
  const path = primary.path ?? other.path, documentId = primary.documentId ?? other.documentId;
  return { ...other, ...primary, key: path ? 'path:' + pathKey(path) : 'document:' + documentId, path, documentId,
    artifactId: primary.artifactId ?? other.artifactId, sourceTitle: primary.sourceTitle ?? other.sourceTitle, targetLanguage: primary.targetLanguage ?? other.targetLanguage,
    sources: [...new Set([...first.sources, ...second.sources])], searchTerms: [...new Set([first.title, second.title, ...(first.searchTerms ?? []), ...(second.searchTerms ?? [])])] };
}

export function buildHomeSearchCandidates(sources: HomeSearchSources): HomeSearchCandidate[] {
  const candidates: HomeSearchCandidate[] = [];
  const add = (candidate: HomeSearchCandidate) => {
    if (!candidate.title || candidate.format === 'web' || candidate.path && (controls.test(candidate.path) || blockedSchemes.test(candidate.path) || /^https?:/i.test(candidate.path))) return;
    const matches = candidates.filter(item => (candidate.documentId && item.documentId === candidate.documentId && (!candidate.path || !item.path || pathKey(item.path) === pathKey(candidate.path))) || (candidate.path && item.path && pathKey(item.path) === pathKey(candidate.path)));
    let merged = candidate;
    for (const match of matches) merged = mergeCandidate(match, merged);
    if (!matches.length) candidates.push(merged);
    else { const firstIndex = candidates.indexOf(matches[0]); for (let i = candidates.length - 1; i >= 0; i--) if (matches.includes(candidates[i])) candidates.splice(i, 1); candidates.splice(firstIndex, 0, merged); }
  };
  for (const document of sources.documents ?? []) add({ key: document.path ? 'path:' + pathKey(document.path) : 'document:' + document.id, source: 'document', sources: ['document'], title: document.title, format: document.format, path: document.path, documentId: document.id });
  for (const sample of sources.samples ?? []) if (sample.path) add({ key: 'path:' + pathKey(sample.path), source: 'sample', sources: ['sample'], title: sample.name, format: sample.format, path: sample.path });
  for (const artifact of sources.artifacts ?? []) if (artifact.path) {
    // Save As can move the associated document identity to a different path.
    // The formal translation at its original path remains a separate file.
    const associated = sources.documents?.find(document => document.id === artifact.documentId && (!document.path || pathKey(document.path) === pathKey(artifact.path)));
    add({ key: 'path:' + pathKey(artifact.path), source: 'translation', sources: ['translation'], title: filename(artifact.path), format: artifact.format, path: artifact.path, documentId: associated?.id, artifactId: artifact.id, sourceTitle: artifact.sourceTitle, targetLanguage: artifact.targetLanguage, searchTerms: [artifact.sourceTitle, artifact.targetLanguage] });
  }
  return candidates;
}

export function rankHomeSearchCandidates(query: string, candidates: readonly HomeSearchCandidate[], limit = 12): RankedHomeSearchCandidate[] {
  const phrase = fold(query.trim()), tokens = [...new Set(phrase.split(/\s+/).filter(Boolean))];
  const matches: { value: RankedHomeSearchCandidate; index: number }[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const title = fold(candidate.title), name = fold(filename(candidate.path ?? candidate.title)), filePath = fold((candidate.path ?? '').replaceAll('\\', '/'));
    const aliases = fold([candidate.sourceTitle, candidate.targetLanguage, ...(candidate.searchTerms ?? [])].filter(Boolean).join(' ')), phrasePath = phrase.replaceAll('\\', '/');
    if (!tokens.every(token => [title, name, filePath, aliases].some(value => value.includes(token.replaceAll('\\', '/'))))) continue;
    let score = priority[candidate.source];
    if (phrase) {
      score += title === phrase ? 1000 : title.startsWith(phrase) ? 700 : title.includes(phrase) ? 400 : 0;
      score += name === phrase ? 900 : name.startsWith(phrase) ? 600 : name.includes(phrase) ? 300 : 0;
      score += filePath === phrasePath ? 800 : filePath.includes(phrasePath) ? 100 : 0;
      for (const token of tokens) score += title.includes(token) ? 60 : name.includes(token) ? 50 : filePath.includes(token.replaceAll('\\', '/')) ? 20 : 10;
    }
    matches.push({ value: { ...candidate, score }, index });
  }
  const count = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 12;
  return matches.sort((a, b) => b.value.score - a.value.score || a.index - b.index).slice(0, count).map(item => item.value);
}
export function homeSearchResults(query: string, sources: HomeSearchSources, limit = 12): RankedHomeSearchCandidate[] {
  return rankHomeSearchCandidates(query, buildHomeSearchCandidates(sources), limit);
}
