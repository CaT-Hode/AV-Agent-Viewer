import { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { glassOpticsCacheStats } from './lib/liquid-glass-optics';
import { GlassInteractionHost } from './components/GlassInteractionHost';
const App = lazy(() => import('./App').then(module => ({ default: module.App })));
const TooltipHost = lazy(() => import('./TooltipHost').then(module => ({ default: module.TooltipHost })));
const SettingsApp = lazy(() => import('./SettingsApp').then(module => ({ default: module.SettingsApp })));
const WebToolbar = lazy(() => import('./WebToolbar').then(module => ({ default: module.WebToolbar })));
const AgentOperationToolbar = lazy(() => import('./AgentOperationToolbar').then(module => ({ default: module.AgentOperationToolbar })));
const AIResultToolbar = lazy(() => import('./AIResultToolbar').then(module => ({ default: module.AIResultToolbar })));
const ReaderPanelWindow = lazy(() => import('./ReaderPanelWindow').then(module => ({ default: module.ReaderPanelWindow })));
const SelectionTools = lazy(() => import('./components/SelectionTools').then(module => ({ default: module.SelectionTools })));
import './reader-panel-window.css';
import './styles.css';
import './new-ui.css';
import './dark-theme.css';
import './motion.css';
import './liquid-glass.css';
import './interaction-motion.css';
import './liquid-glass-surface.css';
import './navigation-toolbar.css';
import './navigation-glass.css';
import './liquid-glass-components.css';
import './glass-elasticity.css';
import './reader-controls.css';
import './office-editing.css';
import './settings-redesign.css';
import './home-search.css';
import './document-paper.css';
import './frosted-shadow.css';
import './sidebar-presence.css';
import './adaptive-panel.css';
declare global { interface Window { __agentViewerRenderingDiagnostics?: () => { glass: ReturnType<typeof glassOpticsCacheStats> } } }
if (window.agentViewer?.testMode) Object.defineProperty(window, '__agentViewerRenderingDiagnostics', { value: () => ({ glass: glassOpticsCacheStats() }) });
if (location.hash === '#/export-worker') {
  // A separate renderer owns exhaustive AST/DOM work. It has only a scoped
  // resource bridge, and never mounts the editor or receives service secrets.
  void import('./lib/markdown-export').then(({renderMarkdownForExport}) => {
    Object.defineProperty(window, '__markdownExport', {value: (source:string,documentId:string) => renderMarkdownForExport(source,documentId,(window as unknown as {markdownExportResource(path:string,kind?:'image'|'media'):Promise<{url:string}>}).markdownExportResource)});
  });
} else createRoot(document.getElementById('root')!).render(<Suspense fallback={null}>{location.hash.startsWith('#/reader-panel?') ? <ReaderPanelWindow /> : location.hash.startsWith('#/settings') ? <SettingsApp /> : location.hash.startsWith('#/web-toolbar') ? <WebToolbar /> : location.hash.startsWith('#/agent-toolbar') ? <AgentOperationToolbar /> : location.hash.startsWith('#/ai-result-toolbar') ? <AIResultToolbar /> : location.hash.startsWith('#/selection-toolbar') ? <SelectionTools native /> : <><App /><SelectionTools /></>}<TooltipHost /><GlassInteractionHost /></Suspense>);
