import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { SearchLocalMemoryRequest } from '../contracts.ts'
import type {
  AppendUploadRequest,
  AppendUploadResult,
  BeginUploadRequest,
  BeginUploadResult,
  CompleteUploadResult,
  DeleteLocalRagDocumentRequest,
  GetSourcePreviewRequest,
  GetSourcePreviewResult,
  GetLocalRagDocumentRequest,
  ImportTextRequest,
  ListLocalRagDocumentsRequest,
  LocalRagDocumentInfo,
  LocalRagModelCatalogItem,
  LocalRagStatusView,
  LocalRagDocumentContent,
  RestoreLocalRagDocumentRequest,
  UpdateLocalRagDocumentRequest,
  ModelSearchResult,
} from '../host/types.ts'
import { localRagDescriptors } from './descriptors.ts'

export interface LocalRagRemoteClient {
  status(signal?: AbortSignal): Promise<LocalRagStatusView>
  importText(request: ImportTextRequest, signal?: AbortSignal): Promise<{ readonly documentId: string }>
  removeDocument(documentId: string, signal?: AbortSignal): Promise<{ readonly removed: boolean }>
  deleteDocument(request: DeleteLocalRagDocumentRequest, signal?: AbortSignal): Promise<{ readonly removed: boolean }>
  listDocuments(request: ListLocalRagDocumentsRequest, signal?: AbortSignal): Promise<readonly LocalRagDocumentInfo[]>
  getDocument(request: GetLocalRagDocumentRequest, signal?: AbortSignal): Promise<LocalRagDocumentContent>
  updateDocument(request: UpdateLocalRagDocumentRequest, signal?: AbortSignal): Promise<LocalRagDocumentContent>
  restoreDocument(request: RestoreLocalRagDocumentRequest, signal?: AbortSignal): Promise<LocalRagDocumentContent>
  rebuild(signal?: AbortSignal): Promise<LocalRagStatusView>
  catalogModels(signal?: AbortSignal): Promise<readonly LocalRagModelCatalogItem[]>
  selectModel(modelId: string, signal?: AbortSignal): Promise<LocalRagStatusView>
  downloadModel(modelId?: string, signal?: AbortSignal): Promise<LocalRagStatusView>
  cancelDownload(signal?: AbortSignal): Promise<LocalRagStatusView>
  startModel(signal?: AbortSignal): Promise<LocalRagStatusView>
  stopModel(signal?: AbortSignal): Promise<LocalRagStatusView>
  setModelAutoStart(enabled: boolean, signal?: AbortSignal): Promise<LocalRagStatusView>
  beginUpload(request: BeginUploadRequest, signal?: AbortSignal): Promise<BeginUploadResult>
  appendUpload(request: AppendUploadRequest, signal?: AbortSignal): Promise<AppendUploadResult>
  completeUpload(uploadId: string, signal?: AbortSignal): Promise<CompleteUploadResult>
  cancelUpload(uploadId: string, signal?: AbortSignal): Promise<void>
  getSourcePreview(request: GetSourcePreviewRequest, signal?: AbortSignal): Promise<GetSourcePreviewResult>
  search(request: SearchLocalMemoryRequest, signal?: AbortSignal): Promise<ModelSearchResult>
  manual(query: string, scope?: SearchLocalMemoryRequest['scope'], signal?: AbortSignal): Promise<ModelSearchResult>
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    localRag: LocalRagRemoteClient
  }
}

export const TYPERT_REMOTE: TypertRemoteContribution = {
  package: 'mindspace-dsh-local-rag',
  descriptors: localRagDescriptors,
}

export default TYPERT_REMOTE
