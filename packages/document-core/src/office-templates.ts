import { officeTemplates } from './generated-office-templates';
import { refreshOfficeTemplateDates } from './office-template-archive';
import type { OfficeTemplateKind } from './office-template-types';

/** A fresh archive for every new document; no shared mutable workbook/slide. */
export async function officeDocumentTemplateBytes(kind: OfficeTemplateKind, createdAt = new Date()): Promise<Uint8Array> {
  const template = officeTemplates.templates[kind];
  if (officeTemplates.schemaVersion !== 1 || !template || !kind.endsWith('.' + template.format)) throw new Error('内置 Office 模板版本无效。');
  return refreshOfficeTemplateDates(new Uint8Array(Buffer.from(template.base64, 'base64')), template.format, createdAt);
}
