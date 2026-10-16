import type { DocumentInfo, DocumentModel, Format } from '../../../../../../packages/contracts/src/index';
import type { OfficeTarget, OfficeToolProps } from './OfficeShared';

export type OfficeToolboxCategory = 'home' | 'insert' | 'table' | 'layout' | 'references' | 'review' | 'view' | 'formulas' | 'data' | 'worksheet' | 'print' | 'design' | 'arrange' | 'slides' | 'transitions' | 'animation' | 'presentation' | 'notes';
export type OfficeToolboxTarget = { kind: 'slide'; slideId: string } | { kind: 'sheet'; sheetId: string };
export type OfficeToolboxController = { viewId: string; documentId: string; navigate(target: OfficeToolboxTarget): Promise<void>; focusFormula?(): void };
export type OfficeToolboxProps = OfficeToolProps & {
  category?: OfficeToolboxCategory;
  onCategoryChange?(category: OfficeToolboxCategory): void;
  onNavigate?(target: OfficeToolboxTarget): Promise<void>;
  onFocusFormula?(): void;
  onReviewAction?(action: 'annotate' | 'annotations'): void;
  canAnnotate?: boolean;
};
type Category = { id: OfficeToolboxCategory; label: string; commands: readonly string[] };
const contributions: Partial<Record<Format, { defaultCategory: OfficeToolboxCategory; categories: readonly Category[] }>> = {
  docx: { defaultCategory: 'home', categories: [
    { id: 'home', label: '开始', commands: ['office.setTextStyle', 'word.setParagraphFormat'] },
    { id: 'insert', label: '插入', commands: ['word.insertParagraph'] },
    { id: 'table', label: '表格', commands: ['word.insertTable'] },
    { id: 'layout', label: '布局', commands: ['word.setParagraphFormat', 'word.setPageLayout'] },
    { id: 'references', label: '引用', commands: [] },
    { id: 'review', label: '审阅', commands: [] },
  ] },
  xlsx: { defaultCategory: 'home', categories: [
    { id: 'home', label: '开始', commands: ['sheets.setRangeFormat', 'sheets.setCellFormat', 'sheets.mergeCells', 'sheets.unmergeCells'] },
    { id: 'insert', label: '插入', commands: ['sheets.insertRows', 'sheets.insertColumns'] },
    { id: 'formulas', label: '公式', commands: ['sheets.setCell'] },
    { id: 'data', label: '数据', commands: ['sheets.sortRange', 'sheets.setAutoFilter'] },
    { id: 'worksheet', label: '工作表', commands: ['sheets.addWorksheet', 'sheets.renameWorksheet', 'sheets.deleteWorksheet', 'sheets.setFreeze', 'sheets.setRowHeight', 'sheets.setColumnWidth', 'sheets.deleteRows', 'sheets.deleteColumns'] },
    { id: 'print', label: '打印', commands: [] },
  ] },
  pptx: { defaultCategory: 'slides', categories: [
    { id: 'slides', label: '幻灯片', commands: ['slides.addSlide', 'slides.duplicateSlide', 'slides.moveSlide', 'slides.deleteSlide'] },
    { id: 'home', label: '开始', commands: ['slides.setShapeStyle'] },
    { id: 'insert', label: '插入', commands: ['slides.addTextShape'] },
    { id: 'design', label: '设计', commands: ['slides.setBackground', 'slides.setShapeStyle'] },
    { id: 'arrange', label: '排列', commands: ['slides.setShapeBounds', 'slides.setShapeStyle'] },
    { id: 'transitions', label: '切换', commands: [] },
    { id: 'animation', label: '动画', commands: [] },
    { id: 'presentation', label: '放映', commands: [] },
    { id: 'notes', label: '备注', commands: [] },
  ] },
};
export function officeToolboxContribution(format: Format) { return contributions[format]; }
export function officeToolboxCategory(format: Format, proposed?: OfficeToolboxCategory): OfficeToolboxCategory {
  const contribution = contributions[format];
  return contribution?.categories.some(category => category.id === proposed) ? proposed! : contribution?.defaultCategory ?? 'home';
}

/** A presentation property inspector must never silently choose the first object. */
export function presentationToolboxSelection(model: DocumentModel, viewId: string, target?: OfficeTarget) {
  const active = target?.viewId === viewId ? target : undefined;
  const slides = model.slides ?? [], slide = slides.find(item => item.id === active?.slideId) ?? slides[0];
  const shape = active?.slideId === slide?.id && active.shapeId ? slide?.blocks.find(item => item.id === active.shapeId) : undefined;
  return { slide, shape };
}

type Binding = {
  document: Pick<DocumentInfo, 'id' | 'format' | 'model'>;
  viewId: string;
  flush(): Promise<void>;
  hasDrafts(): boolean;
  apply(target: OfficeToolboxTarget): void;
  focusFormula?(): void;
};
/** Bind human toolbox navigation to this mounted editor and its latest model. */
export function createOfficeToolboxController(identity: { documentId: string; viewId: string }, current: () => Binding) {
  let active = true, sequence = 0;
  const binding = () => {
    const value = current();
    if (!active || value.viewId !== identity.viewId || value.document.id !== identity.documentId) throw new Error('阅读视图已变化，请在当前文档中重试。');
    return value;
  };
  const validate = (value: Binding, target: OfficeToolboxTarget) => {
    if (target.kind === 'slide' ? value.document.format !== 'pptx' || !value.document.model.slides?.some(slide => slide.id === target.slideId) : value.document.format !== 'xlsx' || !value.document.model.sheets?.some(sheet => sheet.id === target.sheetId)) throw new Error('导航目标已变化或不属于当前文档。');
  };
  const controller: OfficeToolboxController = {
    ...identity,
    async navigate(target) {
      const request = ++sequence, before = binding(); validate(before, target);
      await before.flush();
      const latest = binding();
      if (request !== sequence) throw new Error('新的导航已替代此次跳转。');
      if (latest.hasDrafts()) throw new Error('仍有未提交输入，请完成输入后再切换。');
      validate(latest, target); latest.apply(target);
    },
    focusFormula() { const value = binding(); if (value.document.format !== 'xlsx' || !value.focusFormula) throw new Error('当前视图没有公式栏。'); value.focusFormula(); },
  };
  return { controller, dispose() { active = false; sequence++; } };
}
