import { useEffect, useRef, useState } from 'react';
import { FileUp } from 'lucide-react';
import { LiquidGlassSurface } from './LiquidGlassSurface';
import type { ViewInfo } from '../../../../../packages/contracts/src/index';

export function FileDropHost({ onOpened, reportError, beforeOpen }: { beforeOpen?(): Promise<void>; onOpened(result: { views: ViewInfo[]; errors: string[] }): void; reportError(error: unknown): void }) {
  const callbacks = useRef({ onOpened, reportError, beforeOpen }); callbacks.current = { onOpened, reportError, beforeOpen };
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    let depth = 0;
    const enter = (event: DragEvent) => { if (!event.dataTransfer?.types.includes('Files')) return; event.preventDefault(); depth++; setDragging(true); };
    const over = (event: DragEvent) => { if (!event.dataTransfer?.types.includes('Files')) return; event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; };
    const leave = () => { if (--depth <= 0) { depth = 0; setDragging(false); } };
    const reset = () => { depth = 0; setDragging(false); };
    const drop = (event: DragEvent) => {
      reset(); if (!event.dataTransfer?.files.length) return;
      event.preventDefault(); event.stopPropagation();
      if (!window.agentViewer) { callbacks.current.reportError('从文件管理器拖入文件需要桌面版本。'); return; }
      const files = [...event.dataTransfer.files];
      void Promise.resolve(callbacks.current.beforeOpen?.()).then(() => window.agentViewer!.openDroppedFiles(files)).then(result => callbacks.current.onOpened(result)).catch(error => callbacks.current.reportError(error));
    };
    window.addEventListener('dragenter', enter); window.addEventListener('dragover', over); window.addEventListener('dragleave', leave); window.addEventListener('drop', drop); window.addEventListener('blur', reset);
    return () => { window.removeEventListener('dragenter', enter); window.removeEventListener('dragover', over); window.removeEventListener('dragleave', leave); window.removeEventListener('drop', drop); window.removeEventListener('blur', reset); };
  }, []);
  return dragging ? <div className="file-drop-hint material-host" role="status"><LiquidGlassSurface variant="capsule" /><FileUp size={22} /><span>松开以打开文档</span><small>支持多个文件</small></div> : null;
}
