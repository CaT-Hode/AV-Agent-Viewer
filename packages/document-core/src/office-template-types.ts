export type OfficeTemplateKind = 'demo.pptx' | 'empty.pptx' | 'demo.xlsx' | 'empty.xlsx';

/** Library-generated packages, checked in so shipping does not require generators. */
export interface GeneratedOfficeTemplates {
  schemaVersion: 1;
  generators: { pptxgenjs: string; exceljs: string };
  templates: Record<OfficeTemplateKind, {
    format: 'pptx' | 'xlsx';
    sha256: string;
    base64: string;
  }>;
}
