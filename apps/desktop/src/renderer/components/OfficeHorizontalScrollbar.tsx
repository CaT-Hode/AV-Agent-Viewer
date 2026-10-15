import { DocumentHorizontalScrollbar, type DocumentHorizontalScrollbarProps } from './DocumentHorizontalScrollbar';

export function OfficeHorizontalScrollbar(props:Omit<DocumentHorizontalScrollbarProps,'label'|'className'>) {
  return <DocumentHorizontalScrollbar {...props} label="幻灯片横向滚动" className="office-horizontal-scrollbar" />;
}
