/** Host-facing ports and JSON-safe views for the local RAG capability. */

import type {
  LocalRagHit,
  SearchLocalMemoryRequest,
  SearchLocalMemoryResult,
  SearchScope,
  SourceDocument,
} from '../contracts.ts'

/** Persisted index health exposed to the settings surface. */
export interface LocalRagIndexStatus {
  readonly documentCount: number
  readonly parentCount: number
  readonly childCount: number
  readonly dirty: boolean
  readonly updatedAt: number | null
}

/** Metadata safe to render in the document-management settings page. */
export interface LocalRagDocumentInfo {
  readonly id: string
  readonly title: string
  readonly scope: Exclude<SearchScope, 'both'>
  readonly sessionId?: string
  readonly sourceId?: string
  readonly sourceUri?: string
  readonly source?: string
  readonly updatedAt: number
  readonly characters: number
  readonly deleted?: boolean
  readonly revision: number
  readonly revisionCount: number
}

/** Document-list filter used by the settings Remote. */
export interface ListLocalRagDocumentsRequest {
  readonly scope?: SearchScope
  readonly sessionId?: string
}

/** Model runtime state exposed without leaking a local filesystem path. */
export interface LocalRagModelStatus {
  readonly modelId: string
  readonly ready: boolean
  readonly dimensions: number | null
  readonly state: 'ready' | 'missing' | 'downloading' | 'error'
  readonly message?: string
  readonly selectedModelId?: string
  readonly autoStart?: boolean
  readonly running?: boolean
  readonly indexRebuildRequired?: boolean
  readonly catalog?: readonly LocalRagModelCatalogItem[]
}

/** Public local embedding-model descriptor, deliberately without filesystem paths or source URLs. */
export interface LocalRagModelCatalogItem {
  readonly id: string
  readonly modelId: string
  readonly name?: string
  readonly dimensions?: number
}

/** Narrow local-index boundary owned by the retrieval implementation. */
export interface LocalRagIndexPort {
  initialize(dataRoot: string, signal?: AbortSignal): Promise<void>
  status(): Promise<LocalRagIndexStatus>
  importText(document: SourceDocument, signal?: AbortSignal): Promise<SourceDocument>
  getDocument?(documentId: string, signal?: AbortSignal): Promise<SourceDocument | undefined>
  removeDocument(documentId: string, signal?: AbortSignal): Promise<boolean>
  listDocuments(request?: ListLocalRagDocumentsRequest, signal?: AbortSignal): Promise<readonly LocalRagDocumentInfo[]>
  rebuild(signal?: AbortSignal): Promise<void>
  search(request: SearchLocalMemoryRequest, signal?: AbortSignal): Promise<SearchLocalMemoryResult>
  close?(): Promise<void>
}

/** Narrow local-model boundary owned by the model implementation. */
export interface LocalModelManagerPort {
  status(signal?: AbortSignal): Promise<LocalRagModelStatus>
  catalog(signal?: AbortSignal): Promise<readonly LocalRagModelCatalogItem[]>
  select(modelId: string, signal?: AbortSignal): Promise<LocalRagModelStatus>
  download(modelId: string | undefined, signal?: AbortSignal): Promise<LocalRagModelStatus>
  cancelDownload(signal?: AbortSignal): Promise<LocalRagModelStatus>
  start(signal?: AbortSignal): Promise<LocalRagModelStatus>
  stop(signal?: AbortSignal): Promise<LocalRagModelStatus>
  setAutoStart(enabled: boolean, signal?: AbortSignal): Promise<LocalRagModelStatus>
  acknowledgeIndexRebuilt(modelId?: string, signal?: AbortSignal): Promise<LocalRagModelStatus>
}

/** Dependencies supplied by the retrieval and model packages, or directly by host tests. */
export interface LocalRagHostDependencies {
  readonly index: LocalRagIndexPort
  readonly models: LocalModelManagerPort
}

/** Host configuration that is safe to expose through the settings namespace later. */
export interface LocalRagHostConfig {
  readonly enabled?: boolean
  readonly dataRoot?: string
  readonly vectorCandidates?: number
  readonly lexicalCandidates?: number
  readonly resultLimit?: number
  readonly timeoutMs?: number
  readonly maxOutputChars?: number
  /** Permit runtime-selected persistent auto-start; it never forces a start by itself. */
  readonly autoStart?: boolean
  readonly maxUploadBytes?: number
}

/** Fully resolved local-RAG limits used by the tool Consumer. */
export interface ResolvedLocalRagHostConfig {
  readonly enabled: boolean
  readonly dataRoot: string
  readonly vectorCandidates: number
  readonly lexicalCandidates: number
  readonly resultLimit: number
  readonly timeoutMs: number
  readonly maxOutputChars: number
  readonly autoStart: boolean
  readonly maxUploadBytes: number
}

/** User-initiated text import request crossing the Remote boundary. */
export interface ImportTextRequest {
  readonly id?: string
  readonly title: string
  readonly text: string
  readonly scope: Exclude<SearchScope, 'both'>
  readonly sessionId?: string
  readonly source?: string
}

export type LocalRagDocumentRevisionAction = 'created' | 'edited' | 'deleted' | 'restored'

export interface LocalRagDocumentRevisionInfo {
  readonly revision: number
  readonly action: LocalRagDocumentRevisionAction
  readonly at: number
  readonly reason?: string
  readonly title?: string
  readonly characters: number
  readonly deleted: boolean
}

export interface GetLocalRagDocumentRequest {
  readonly documentId: string
  readonly sessionId?: string
}

export interface LocalRagDocumentContent {
  readonly documentId: string
  readonly title: string
  readonly text: string
  readonly scope: Exclude<SearchScope, 'both'>
  readonly sessionId?: string
  readonly sourceId?: string
  readonly sourceUri?: string
  readonly source?: string
  readonly updatedAt: number
  readonly revision: number
  readonly deleted: boolean
  readonly versions: readonly LocalRagDocumentRevisionInfo[]
}

export interface UpdateLocalRagDocumentRequest {
  readonly documentId: string
  readonly title: string
  readonly text: string
  readonly expectedRevision: number
  readonly sessionId?: string
  readonly reason?: string
}

export interface DeleteLocalRagDocumentRequest {
  readonly documentId: string
  readonly expectedRevision: number
  readonly sessionId?: string
  readonly reason?: string
}

export interface RestoreLocalRagDocumentRequest {
  readonly documentId: string
  readonly revision: number
  readonly expectedRevision: number
  readonly sessionId?: string
  readonly reason?: string
}

/** Global service view consumed by the Web settings page. */
export interface LocalRagStatusView {
  readonly enabled: boolean
  readonly index: LocalRagIndexStatus
  readonly model: LocalRagModelStatus
  readonly backgroundIndexing: LocalRagBackgroundIndexStatus
}

/** Fire-and-forget compaction-summary indexing state, surfaced so an error is never silent. */
export interface LocalRagBackgroundIndexStatus {
  readonly lastDocumentId: string | null
  readonly lastIndexedAt: number | null
  readonly lastError: string | null
}

/** Accepted upload metadata. Every completed upload becomes a knowledge document. */
export interface BeginUploadRequest {
  readonly fileName: string
  readonly size: number
  readonly url?: string
  readonly source?: string
}

export interface BeginUploadResult {
  readonly uploadId: string
  readonly maxChunkBytes: number
}

export interface AppendUploadRequest {
  readonly uploadId: string
  readonly offset: number
  readonly dataBase64: string
}

export interface AppendUploadResult {
  readonly receivedBytes: number
  readonly complete: boolean
}

export interface CompleteUploadResult {
  readonly documentId: string
  readonly title: string
  readonly characters: number
  readonly sourceId: string
  readonly sourceUri: string
}

/** Opaque source-file identity, never a local filesystem path. */
export interface StoredLocalRagSource {
  readonly sourceId: string
  readonly sourceUri: string
  readonly fileName: string
  readonly byteLength: number
}

/** Page extracted from an archived source file; `sourceAddress` is always a safe URI or `unavailable`. */
export interface GetSourcePreviewRequest {
  readonly documentId: string
  readonly cursor?: number
  readonly limit?: number
}

export interface GetSourcePreviewResult {
  readonly documentId: string
  readonly sourceId?: string
  readonly sourceUri?: string
  readonly kind?: string
  readonly title?: string
  readonly sourceAddress: string
  readonly textPage?: string
  readonly offset?: number
  readonly nextCursor?: number
  readonly canPreview: boolean
}

/** Narrow Host boundary for paged source preview and archive cleanup. */
export interface LocalRagSourceReader {
  getPreview(request: GetSourcePreviewRequest, signal?: AbortSignal): Promise<GetSourcePreviewResult>
  removeForDocument(documentId: string): Promise<boolean>
  replacePreview(documentId: string, text: string): Promise<void>
}

/** One model-safe retrieval result, already subject to the host output cap. */
export interface ModelSearchResult extends SearchLocalMemoryResult {
  readonly hits: readonly LocalRagHit[]
}
