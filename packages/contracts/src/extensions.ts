import type { Capabilities, DocumentInfo, DocumentModel, Locator, PreparedPatch, ReadingContext, Receipt, Rect } from './index';

/** Reserved contracts. Providers must advertise support before exposing their tools. */
export interface ExtensionDescriptor {
  id: string;
  version: string;
  protocolMajor: number;
  features: Record<string, { available: boolean; reason?: string }>;
}

/** A native editor bridge must report the actual viewport separately from the caret. */
export interface ViewBridge {
  attach(viewId: string, document: DocumentInfo, report: (context: ReadingContext) => void): Promise<void>;
  reveal(viewId: string, locator: Locator, expectedRevision: number): Promise<ReadingContext>;
  captureRegion(viewId: string, bounds: Rect): Promise<{ mimeType: string; artifactId: string; revision: number }>;
  detach(viewId: string): Promise<void>;
}

/** Full Office editors can own a live session instead of repeatedly rewriting a ZIP. */
export interface OfficeEngineSession {
  sessionId: string;
  engineEpoch: string;
  documentId: string;
  capabilities: Capabilities;
  bridge: ViewBridge;
  read(expectedRevision: number, locator?: Locator): Promise<DocumentModel>;
  prepare(command: { namespace: string; kind: string; payload: unknown; expectedRevision: number }): Promise<PreparedPatch>;
  commit(patchId: string, idempotencyKey: string): Promise<Receipt>;
  export(format: string, expectedRevision: number): Promise<{ bytes: Uint8Array; warnings: string[] }>;
  close(): Promise<void>;
}

export interface OfficeGateway {
  descriptor: ExtensionDescriptor;
  health(): Promise<{ available: boolean; engineVersion?: string; reason?: string }>;
  open(document: DocumentInfo, bytes: Uint8Array): Promise<OfficeEngineSession>;
}

/** References are bound to a navigation and frame, never an unqualified element index. */
export interface BrowserElementRef { id: string; viewId: string; navigationId: string; frameId: string }
export interface BrowserSemanticExtension {
  descriptor: ExtensionDescriptor;
  observe(viewId: string, expectedNavigationId: string, budget: number): Promise<{ elements: { ref: BrowserElementRef; role: string; name: string; bounds?: Rect }[]; incompleteFrames: string[]; truncated: boolean }>;
  resolve(ref: BrowserElementRef): Promise<{ bounds: Rect; visible: boolean; enabled: boolean }>;
}

export interface AuthorizationProvider {
  authorize(request: { clientId: string; documentId?: string; viewId?: string; capability: string; origin?: string }): Promise<{ allowed: boolean; reason?: string }>;
  revoke(clientId: string): Promise<void>;
}

export interface ArtifactRepository {
  put(bytes: Uint8Array, metadata: { mimeType: string; revision: number; documentId: string }): Promise<{ id: string; sha256: string }>;
  read(id: string): Promise<{ bytes: Uint8Array; mimeType: string; sha256: string }>;
  removeUnreferenced(ids: string[]): Promise<void>;
}
