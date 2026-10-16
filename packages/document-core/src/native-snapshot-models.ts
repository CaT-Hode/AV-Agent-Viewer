import { isDeepStrictEqual } from 'node:util';
import type { DocumentInfo, DocumentModel, ReadingContext, ReadingSnapshot } from '../../contracts/src/index';

type CachedModel = { revision: number; model: WeakRef<DocumentModel>; hasAliases: boolean };
type PlainGraph = { hasAliases: boolean; objects: WeakSet<object> };

/** Only ordinary data properties can be made immutable by recursively freezing.
 * Date/Map/Set/buffers and custom prototypes need the normal clone path instead. */
function plainGraph(root: unknown, excluded?: (value: object) => boolean): PlainGraph | undefined {
  const pending: unknown[] = [root], seen = new WeakSet<object>();
  let hasAliases = false;
  while (pending.length) {
    const value = pending.pop();
    if (value === null || typeof value !== 'object') {
      if (typeof value === 'function' || typeof value === 'symbol') return;
      continue;
    }
    if (excluded?.(value)) return;
    if (seen.has(value)) { hasAliases = true; continue; }
    seen.add(value);
    const array = Array.isArray(value);
    if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) return;
    for (const key of Reflect.ownKeys(value)) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') return;
      const property = Object.getOwnPropertyDescriptor(value, key)!;
      if (!property.enumerable || !Object.hasOwn(property, 'value')) return;
      pending.push(property.value);
    }
  }
  return { hasAliases, objects: seen };
}

/** Inspect without evaluating accessors. Unknown metadata may legally share a
 * model child (warnings/unsupportedFeatures, for example); splitting that graph
 * would change public structuredClone semantics, so the caller must fall back. */
function documentParts(document: DocumentInfo): { source: DocumentModel; metadata: Omit<DocumentInfo, 'model'> } | undefined {
  if (Object.getPrototypeOf(document) !== Object.prototype) return;
  const metadata: Record<string, unknown> = {};
  let source: DocumentModel | undefined;
  for (const key of Reflect.ownKeys(document)) {
    if (typeof key !== 'string') return;
    const property = Object.getOwnPropertyDescriptor(document, key)!;
    if (!property.enumerable || !Object.hasOwn(property, 'value')) return;
    if (key === 'model') source = property.value;
    else Object.defineProperty(metadata, key, { ...property, value: property.value });
  }
  if (!source || typeof source !== 'object') return;
  return { source, metadata: metadata as Omit<DocumentInfo, 'model'> };
}

/** Deep value equality alone does not notice a source changing shared children
 * into equal, distinct objects (or the reverse). Preserve structuredClone's graph. */
function sameReferences(source: object, copy: object): boolean {
  const pending: [object, object][] = [[source, copy]], forward = new WeakMap<object, object>(), reverse = new WeakMap<object, object>();
  while (pending.length) {
    const [left, right] = pending.pop()!;
    if (forward.has(left)) { if (forward.get(left) !== right) return false; continue; }
    if (reverse.has(right)) return false;
    forward.set(left, right); reverse.set(right, left);
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length) return false;
    for (const key of keys) {
      if (!Object.hasOwn(right, key)) return false;
      const a = (left as Record<string, unknown>)[key], b = (right as Record<string, unknown>)[key];
      if (a !== null && typeof a === 'object') {
        if (b === null || typeof b !== 'object') return false;
        pending.push([a, b]);
      } else if (b !== null && typeof b === 'object') return false;
    }
  }
  return true;
}

function freezeGraph<T extends object>(root: T): T {
  const pending: object[] = [root], seen = new WeakSet<object>();
  while (pending.length) {
    const value = pending.pop()!;
    if (seen.has(value)) continue;
    seen.add(value);
    for (const child of Object.values(value)) if (child !== null && typeof child === 'object') pending.push(child);
    Object.freeze(value);
  }
  return root;
}

/** Internal retention only. Core must continue cloning snapshots on every public
 * return/read; callers must never return these retained parts to an API client.
 * Neither source keys nor copied bodies are kept alive by the cache. Retained
 * snapshots own their frozen version; eviction releases that ownership even
 * while the source document remains in the library. */
export class NativeOfficeSnapshotModels {
  private readonly cache = new WeakMap<DocumentModel, CachedModel>();

  capture(document: DocumentInfo, context: ReadingContext, nativeBound: boolean): Pick<ReadingSnapshot, 'document' | 'context'> {
    const parts = nativeBound ? documentParts(document) : undefined;
    if (!parts) return { document: structuredClone(document), context: structuredClone(context) };
    const { source, metadata } = parts;
    const office = metadata.format === 'docx' || metadata.format === 'xlsx' || metadata.format === 'pptx';
    const graph = office ? plainGraph(source) : undefined;
    const metadataIndependent = graph && plainGraph(metadata, value => value === document || graph.objects.has(value));
    if (!graph || !metadataIndependent || source.format !== metadata.format) {
      this.cache.delete(source);
      return { document: structuredClone(document), context: structuredClone(context) };
    }
    const cached = this.cache.get(source), retained = cached?.model.deref();
    let model: DocumentModel;
    if (cached?.revision === metadata.revision && retained && isDeepStrictEqual(source, retained)
      && (!(graph.hasAliases || cached.hasAliases) || sameReferences(source, retained))) {
      model = retained;
    } else {
      model = freezeGraph(structuredClone(source));
      this.cache.set(source, { revision: metadata.revision, model: new WeakRef(model), hasAliases: graph.hasAliases });
    }
    return { document: { ...structuredClone(metadata), model }, context: structuredClone(context) };
  }
}
