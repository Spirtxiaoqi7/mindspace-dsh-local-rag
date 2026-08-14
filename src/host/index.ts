/** Public Host entry for the local RAG bundle. */

export { default } from './service.ts'
export { LocalRagService, resolveLocalRagHostConfig } from './service.ts'
export { createLocalRagRuntime } from './runtime.ts'
export { CompactionSummaryIndexer } from './summary-indexing.ts'
export { DEFAULT_MAX_UPLOAD_BYTES, LocalRagUploadManager, MAX_UPLOAD_CHUNK_BYTES } from './upload.ts'
export { LocalRagSourceArchive, MAX_SOURCE_PREVIEW_CHARS, stableSourceId } from './sources.ts'
export { LOCAL_RAG_TOOL_GUIDANCE, formatLocalMemorySearch, formatLocalSourcePreview, limitModelSearchResult, parseSearchQuery, parseSearchScope, registerLocalRagTool } from './tool.ts'
export type {
  ImportTextRequest,
  BeginUploadRequest,
  BeginUploadResult,
  AppendUploadRequest,
  AppendUploadResult,
  CompleteUploadResult,
  GetSourcePreviewRequest,
  GetSourcePreviewResult,
  ListLocalRagDocumentsRequest,
  LocalRagBackgroundIndexStatus,
  LocalRagDocumentInfo,
  LocalModelManagerPort,
  LocalRagModelCatalogItem,
  LocalRagHostConfig,
  LocalRagHostDependencies,
  LocalRagIndexPort,
  LocalRagIndexStatus,
  LocalRagModelStatus,
  LocalRagStatusView,
  LocalRagSourceReader,
  ModelSearchResult,
  ResolvedLocalRagHostConfig,
  StoredLocalRagSource,
} from './types.ts'
