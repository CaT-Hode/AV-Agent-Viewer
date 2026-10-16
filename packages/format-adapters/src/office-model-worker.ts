import { parentPort } from 'node:worker_threads';
import { OfficeXmlAdapter } from './ooxml-editing';
import { SheetAdapter } from './sheet-editing';
import type { Format } from '../../contracts/src/index';

const xml = new OfficeXmlAdapter(), sheets = new SheetAdapter();
if (!parentPort) throw new Error('OFFICE_MODEL_WORKER_PORT_MISSING');
parentPort.on('message', async (request: { id: number; format: Format; bytes: Uint8Array }) => {
  try {
    if (!['docx', 'pptx', 'xlsx'].includes(request.format) || !(request.bytes instanceof Uint8Array) || request.bytes.byteLength > 100 * 1024 * 1024) throw new Error('INVALID_OFFICE_MODEL_SOURCE');
    const model = await (request.format === 'xlsx' ? sheets : xml).open(request.bytes, request.format);
    parentPort!.postMessage({ id: request.id, model });
  } catch (cause) {
    const error = cause as { code?: unknown; message?: unknown };
    parentPort!.postMessage({ id: request.id, error: { code: typeof error.code === 'string' ? error.code : 'OFFICE_MODEL_PARSE_FAILED', message: typeof error.message === 'string' ? error.message : 'Office 辅助模型解析失败。' } });
  }
});
