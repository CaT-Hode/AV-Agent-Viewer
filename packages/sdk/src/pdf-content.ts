import { PDFArray, PDFBool, PDFCheckBox, PDFDict, PDFDocument, PDFDropdown, PDFHexString, PDFName, PDFNumber, PDFOptionList, PDFRadioGroup, PDFString, PDFTextField, degrees } from 'pdf-lib';
import { randomUUID } from 'node:crypto';
import { ViewerError } from '../../contracts/src/index';

export type PdfMutation =
  | { action: 'rotate'; page: number; degrees: number }
  | { action: 'add'; page?: number }
  | { action: 'delete'; page: number }
  | { action: 'reorder'; order: number[] }
  | { action: 'form'; name: string; value: string | boolean }
  | { action: 'annotation-add'; page: number; kind: 'text' | 'highlight' | 'underline' | 'strike'; text?: string; x: number; y: number; width: number; height: number }
  | { action: 'annotation-delete'; page: number; index: number };

const fail = (message: string): never => { throw new ViewerError('INVALID_ARGUMENT', message); };
function pageAt(pdf: PDFDocument, index: number) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= pdf.getPageCount()) fail('PDF page index is outside the frozen document.');
  return pdf.getPage(index);
}
const valueOf = (dict: PDFDict, key: string): unknown => {
  const value = dict.lookup(PDFName.of(key));
  if (value instanceof PDFString || value instanceof PDFHexString) return value.decodeText();
  if (value instanceof PDFName) return value.decodeText();
  if (value instanceof PDFNumber) return value.asNumber();
  if (value instanceof PDFBool) return value.asBoolean();
  return undefined;
};
export function pdfAnnotations(pdf: PDFDocument, pageIndex: number, limit = 100, offset = 0) {
  const page = pageAt(pdf, pageIndex), list = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  if (!list) return [];
  return Array.from({ length: Math.max(0, Math.min(limit, list.size() - offset)) }, (_, position) => {
    const index = position + offset;
    const item = list.lookup(index, PDFDict), rectangle = item.lookupMaybe(PDFName.of('Rect'), PDFArray);
    const rect = rectangle?.asArray().map(value => pdf.context.lookup(value, PDFNumber).asNumber());
    return { index, kind: valueOf(item, 'Subtype'), id: valueOf(item, 'NM'), text: String(valueOf(item, 'Contents') ?? '').slice(0, 100000), rect, coordinateSpace: 'pdf-points-bottom-left' as const };
  });
}
export function pdfForms(pdf: PDFDocument, limit = 100) {
  return pdf.getForm().getFields().slice(0, limit).map(field => {
    const base = { name: field.getName(), readOnly: field.isReadOnly(), required: field.isRequired() };
    if (field instanceof PDFTextField) return { ...base, kind: 'text', value: field.getText() ?? '' };
    if (field instanceof PDFCheckBox) return { ...base, kind: 'checkbox', value: field.isChecked() };
    if (field instanceof PDFDropdown || field instanceof PDFOptionList) return { ...base, kind: field instanceof PDFDropdown ? 'dropdown' : 'list', value: field.getSelected(), options: field.getOptions() };
    if (field instanceof PDFRadioGroup) return { ...base, kind: 'radio', value: field.getSelected(), options: field.getOptions() };
    return { ...base, kind: 'unsupported' };
  });
}
export async function readPdfStructure(bytes: Uint8Array, page = 0, annotationOffset = 0) {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const annotations = pdfAnnotations(pdf, page, 100, annotationOffset), annotationsTotal = pageAt(pdf, page).node.lookupMaybe(PDFName.of('Annots'), PDFArray)?.size() ?? 0;
  const forms = pdfForms(pdf), formsTotal = pdf.getForm().getFields().length;
  return { pageCount: pdf.getPageCount(), forms, formsTotal, formsTruncated: forms.length < formsTotal, page, annotations, annotationsTotal, annotationOffset, annotationsTruncated: annotationOffset + annotations.length < annotationsTotal };
}

/** Pure frozen-byte transform. The caller owns revision checks, receipts,
 * document publication, recovery and explicit disk saving. */
export async function mutatePdfBytes(bytes: Uint8Array, operation: PdfMutation) {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  let readback: Record<string, unknown>;
  switch (operation.action) {
    case 'rotate': {
      if (!Number.isSafeInteger(operation.degrees) || operation.degrees % 90 !== 0) fail('Rotation must be an integer multiple of 90 degrees.');
      const page = pageAt(pdf, operation.page), angle = ((page.getRotation().angle + operation.degrees) % 360 + 360) % 360;
      page.setRotation(degrees(angle)); readback = { page: operation.page, rotation: angle }; break;
    }
    case 'add': {
      const index = operation.page ?? pdf.getPageCount();
      if (!Number.isSafeInteger(index) || index < 0 || index > pdf.getPageCount()) fail('Invalid page insertion index.');
      pdf.insertPage(index); readback = { page: index, pageCount: pdf.getPageCount() }; break;
    }
    case 'delete': {
      pageAt(pdf, operation.page);
      if (pdf.getPageCount() <= 1) fail('The final PDF page cannot be deleted.');
      if (pdf.getForm().getFields().length) throw new ViewerError('CAPABILITY_UNSUPPORTED', 'Deleting pages containing an AcroForm requires widget relocation support.');
      pdf.removePage(operation.page); readback = { pageCount: pdf.getPageCount() }; break;
    }
    case 'reorder': {
      const pages = pdf.getPages(), order = operation.order;
      if (order.length !== pages.length || new Set(order).size !== pages.length || order.some(index => !Number.isSafeInteger(index) || index < 0 || index >= pages.length)) fail('Page order must contain every existing page exactly once.');
      for (let index = pages.length - 1; index >= 0; index--) pdf.removePage(index);
      for (const index of order) pdf.addPage(pages[index]);
      readback = { pageCount: pages.length, order }; break;
    }
    case 'form': {
      const field = pdf.getForm().getField(operation.name);
      if (field.isReadOnly()) throw new ViewerError('CAPABILITY_UNSUPPORTED', 'The selected form field is read only.');
      if (field instanceof PDFCheckBox && typeof operation.value === 'boolean') operation.value ? field.check() : field.uncheck();
      else if (field instanceof PDFTextField && typeof operation.value === 'string') field.setText(operation.value);
      else if ((field instanceof PDFDropdown || field instanceof PDFOptionList || field instanceof PDFRadioGroup) && typeof operation.value === 'string') {
        if (!field.getOptions().includes(operation.value)) fail('The requested choice is not an existing form option.');
        field.select(operation.value);
      } else throw new ViewerError('CAPABILITY_UNSUPPORTED', 'This form field type or value is unsupported.');
      readback = { field: pdfForms(pdf, Number.MAX_SAFE_INTEGER).find(value => value.name === operation.name) }; break;
    }
    case 'annotation-add': {
      const page = pageAt(pdf, operation.page), { x, y, width, height } = operation, box = page.getCropBox();
      if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0 || x < box.x || y < box.y || x + width > box.x + box.width || y + height > box.y + box.height) fail('Annotation rectangle must fit inside the page crop box in PDF points.');
      const subtype = { text: 'Text', highlight: 'Highlight', underline: 'Underline', strike: 'StrikeOut' }[operation.kind];
      const annotation = pdf.context.obj({ Type: 'Annot', Subtype: subtype, Rect: [x, y, x + width, y + height], Contents: PDFHexString.fromText(operation.text ?? ''), NM: PDFString.of(randomUUID()), C: [1, .85, 0], F: 4, ...(operation.kind === 'text' ? { Name: 'Note', Open: false } : { QuadPoints: [x, y + height, x + width, y + height, x, y, x + width, y], CA: .4 }) });
      page.node.addAnnot(pdf.context.register(annotation));
      const count = page.node.lookup(PDFName.of('Annots'), PDFArray).size();
      readback = { page: operation.page, annotation: pdfAnnotations(pdf, operation.page, 1, count - 1)[0], annotationsTotal: count }; break;
    }
    case 'annotation-delete': {
      const page = pageAt(pdf, operation.page), list = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
      if (!list || !Number.isSafeInteger(operation.index) || operation.index < 0 || operation.index >= list.size()) fail('Annotation does not exist.');
      const kind = valueOf(list!.lookup(operation.index, PDFDict), 'Subtype');
      if (!['Text', 'Highlight', 'Underline', 'StrikeOut', 'Squiggly', 'FreeText', 'Ink', 'Square', 'Circle', 'Line', 'Stamp'].includes(String(kind))) throw new ViewerError('CAPABILITY_UNSUPPORTED', 'Deleting widget/link or unknown annotation types is not supported.');
      list!.remove(operation.index); readback = { page: operation.page, deletedIndex: operation.index, annotationsTotal: list!.size() }; break;
    }
  }
  const output = await pdf.save({ updateFieldAppearances: true });
  const verified = await PDFDocument.load(output, { updateMetadata: false });
  if (!verified.getPageCount()) throw new ViewerError('PDF_VERIFY_FAILED', 'The resulting PDF has no readable pages.');
  return { bytes: output, readback: { ...readback, pageCount: verified.getPageCount() } };
}
