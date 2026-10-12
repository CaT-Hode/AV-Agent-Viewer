import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUpRight, FileText, Globe, Languages, LoaderCircle, Search, X } from 'lucide-react';
import { LiquidGlassSurface } from './LiquidGlassSurface';
import { MotionPresence } from './MotionPresence';
import { classifyHomeQuery, rankHomeSearchCandidates, type HomeSearchCandidate } from '../lib/home-search';

type Props = {
  query: string;
  pending?: boolean;
  candidates: HomeSearchCandidate[];
  onQueryChange(query: string): void;
  onOpenUri(uri: string): Promise<void>;
  onOpenCandidate(candidate: HomeSearchCandidate): Promise<void>;
};

/** One omnibox for the current new tab. Results are local metadata, and opening
 * a result goes through the document session instead of reloading its bytes. */
export function HomeSearch({ query, pending = false, candidates, onQueryChange, onOpenUri, onOpenCandidate }: Props) {
  const input = useRef<HTMLInputElement>(null), root = useRef<HTMLDivElement>(null), composing = useRef(false), request = useRef(false);
  const listId = 'home-search-' + useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const [focused, setFocused] = useState(false), [dismissed, setDismissed] = useState(false), [active, setActive] = useState(0), [localBusy, setLocalBusy] = useState(false), [error, setError] = useState('');
  const busy = pending || localBusy;
  const classified = useMemo(() => classifyHomeQuery(query), [query]);
  const results = useMemo(() => rankHomeSearchCandidates(query, candidates, 8), [query, candidates]);
  const options = classified.kind === 'url' || classified.kind === 'file' ? [{ key: 'open-address', title: classified.kind === 'url' ? classified.url : classified.path, address: true as const }] : results.map(candidate => ({ key: candidate.key, title: candidate.title, candidate, address: false as const }));
  const index = Math.min(active, Math.max(0, options.length - 1)), show = focused && !dismissed && !!query.trim();
  const hasOptions = !error && classified.kind !== 'invalid' && options.length > 0;
  function change(next: string) { onQueryChange(next); setActive(0); setDismissed(false); setError(''); }
  async function open(option = options[index]) {
    if (busy || request.current || composing.current || classified.kind === 'empty') return;
    if (classified.kind === 'invalid') { setError(classified.reason); setDismissed(false); return; }
    if (!option) return;
    request.current = true; setLocalBusy(true); setError('');
    try {
      if (classified.kind === 'url') await onOpenUri(classified.url);
      else if (classified.kind === 'file') await onOpenUri(classified.path);
      else if ('candidate' in option) await onOpenCandidate(option.candidate);
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); setDismissed(false); }
    finally { request.current = false; setLocalBusy(false); }
  }
  function key(event: KeyboardEvent<HTMLInputElement>) {
    // Chromium may report Enter immediately before compositionend. Native
    // keyCode 229 covers that ordering without blocking the next real Enter.
    if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === 'Escape') { event.preventDefault(); setDismissed(true); setError(''); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setDismissed(false); setActive(previous => options.length ? (previous + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length : 0); }
    else if (event.key === 'Enter') { event.preventDefault(); void open(); }
  }
  return <div className="home-search-shell" ref={root} data-busy={busy || undefined}>
    <div className="home-search-capsule material-host" onClick={() => input.current?.focus()}>
      <LiquidGlassSurface variant="search" effect="refractive" />
      <Search size={20} aria-hidden="true" />
      <input ref={input} className="home-search-input" role="combobox" aria-label="输入网址或搜索文件" placeholder="输入网址或搜索文件" value={query} autoComplete="off" spellCheck={false} readOnly={busy}
        aria-autocomplete="list" aria-expanded={show} aria-controls={show ? listId : undefined} aria-activedescendant={show && hasOptions ? listId + '-' + index : undefined} aria-busy={busy}
        onMouseDown={event => { if (window.document.activeElement !== event.currentTarget) event.preventDefault(); }}
        onChange={event => change(event.target.value)} onKeyDown={key} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
        onFocus={() => { setFocused(true); setDismissed(false); }} onBlur={event => { if (!root.current?.contains(event.relatedTarget)) setFocused(false); }} />
      {busy ? <LoaderCircle size={17} className="home-search-loading" aria-label="正在打开" /> : query ? <button className="home-search-clear" aria-label="清空搜索" title="清空搜索" onMouseDown={event => event.preventDefault()} onClick={event => { event.stopPropagation(); change(''); input.current?.focus(); }}><X size={16} /></button> : <kbd aria-hidden="true">Ctrl L</kbd>}
    </div>
    <MotionPresence show={show} duration={180} surface="popover">
      <div id={listId} className="home-search-results material-host"><LiquidGlassSurface variant="panel" />
        <div className="home-search-result-heading">{classified.kind === 'url' ? '打开网页' : classified.kind === 'file' ? '打开本地文件' : '文档库、示例与译文'}</div>
        {error || classified.kind === 'invalid' ? <p className="home-search-message" role="alert">{error || (classified.kind === 'invalid' ? classified.reason : '')}</p> : options.length ?
          <div role="listbox" aria-label="搜索结果">{options.map((option, position) => {
            const candidate = 'candidate' in option ? option.candidate : undefined;
            return <button type="button" role="option" aria-selected={index === position} id={listId + '-' + position} key={option.key} data-candidate-key={option.key} data-document-id={candidate?.documentId} data-path={candidate?.path}
              className="home-search-result" disabled={busy} onMouseDown={event => event.preventDefault()} onPointerMove={() => setActive(position)} onClick={() => void open(option)} tabIndex={-1}>
              <span className={'home-search-result-icon ' + (candidate?.format ?? 'web')}>{candidate ? candidate.sources.includes('translation') ? <Languages size={18} /> : <FileText size={18} /> : classified.kind === 'file' ? <FileText size={18} /> : <Globe size={18} />}</span>
              <span className="home-search-result-copy"><strong>{option.title}</strong><small>{candidate ? candidate.sources.includes('translation') ? '译文' + (candidate.targetLanguage ? ' · ' + candidate.targetLanguage : '') : candidate.source === 'sample' ? '示例文件' : '文档库' : classified.kind === 'file' ? '本地文件' : '按 Enter 在当前标签打开'}</small></span><ArrowUpRight size={16} aria-hidden="true" />
            </button>;
          })}</div> : <p className="home-search-message" role="status">没有找到匹配文件。可以输入完整路径打开本地文件。</p>}
        <div className="home-search-hint"><span>↑ ↓ 选择</span><span>Enter 打开</span><span>Esc 收起</span></div>
      </div>
    </MotionPresence>
  </div>;
}
