import { createWorker } from 'tesseract.js';
import { ocrLanguageDir } from '../../engines/src/index';
import { ViewerError } from '../../contracts/src/index';

export type OcrResult = { text: string; confidence: number; language: string };

export async function recognizeImage(image: Uint8Array, appRoot: string, signal?: AbortSignal, language: 'eng' | 'chi_sim' | 'eng+chi_sim' = 'eng+chi_sim'): Promise<OcrResult> {
  const langPath = ocrLanguageDir(appRoot);
  if (!langPath) throw new ViewerError('ENGINE_REQUIRED', '未找到内置 OCR 字库。');
  if (image.length === 0 || image.length > 20_000_000) throw new ViewerError('IMAGE_SIZE', 'OCR 图片为空或超过 20 MB。');
  if (signal?.aborted) throw new ViewerError('CANCELLED', 'OCR 已取消。');
  const worker = await createWorker(language, 1, { langPath, gzip: true, cacheMethod: 'readOnly' });
  const cancel = () => { void worker.terminate(); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const result = await worker.recognize(Buffer.from(image));
    if (signal?.aborted) throw new ViewerError('CANCELLED', 'OCR 已取消。');
    return { text: result.data.text.trim(), confidence: Math.round(result.data.confidence), language };
  } finally {
    signal?.removeEventListener('abort', cancel);
    await worker.terminate().catch(() => {});
  }
}
