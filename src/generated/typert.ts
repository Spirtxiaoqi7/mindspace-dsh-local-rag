import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry/types'
import { localRagDescriptors } from './descriptors.ts'

export const TYPERT: TypertContribution = {
  package: 'mindspace-dsh-local-rag',
  face: 'host',
  schemas: [],
  invocations: localRagDescriptors,
  model: {
    services: [{
      key: 'localRag',
      exportName: 'LocalRagService',
      members: [
        { kind: 'method', name: 'status', signature: '@Remote status(signal: AbortSignal): Promise<LocalRagStatusView>' },
        { kind: 'method', name: 'importText', signature: '@Remote importText(request: ImportTextRequest, signal: AbortSignal): Promise<{ documentId: string }>' },
        { kind: 'method', name: 'removeDocument', signature: '@Remote removeDocument(documentId: string, signal: AbortSignal): Promise<{ removed: boolean }>' },
        { kind: 'method', name: 'deleteDocument', signature: '@Remote deleteDocument(request: DeleteLocalRagDocumentRequest, signal: AbortSignal): Promise<{ removed: boolean }>' },
        { kind: 'method', name: 'listDocuments', signature: '@Remote listDocuments(request: ListLocalRagDocumentsRequest, signal: AbortSignal): Promise<readonly LocalRagDocumentInfo[]>' },
        { kind: 'method', name: 'getDocument', signature: '@Remote getDocument(request: GetLocalRagDocumentRequest, signal: AbortSignal): Promise<LocalRagDocumentContent>' },
        { kind: 'method', name: 'updateDocument', signature: '@Remote updateDocument(request: UpdateLocalRagDocumentRequest, signal: AbortSignal): Promise<LocalRagDocumentContent>' },
        { kind: 'method', name: 'restoreDocument', signature: '@Remote restoreDocument(request: RestoreLocalRagDocumentRequest, signal: AbortSignal): Promise<LocalRagDocumentContent>' },
        { kind: 'method', name: 'rebuild', signature: '@Remote rebuild(signal: AbortSignal): Promise<LocalRagStatusView>' },
        { kind: 'method', name: 'catalogModels', signature: '@Remote catalogModels(signal: AbortSignal): Promise<readonly LocalRagModelCatalogItem[]>' },
        { kind: 'method', name: 'selectModel', signature: '@Remote selectModel(modelId: string, signal: AbortSignal): Promise<LocalRagStatusView>' },
        { kind: 'method', name: 'downloadModel', signature: '@Remote downloadModel(modelId: string | undefined, signal: AbortSignal): Promise<LocalRagStatusView>' },
        { kind: 'method', name: 'cancelDownload', signature: '@Remote cancelDownload(signal: AbortSignal): Promise<LocalRagStatusView>' },
        { kind: 'method', name: 'startModel', signature: '@Remote startModel(signal: AbortSignal): Promise<LocalRagStatusView>' },
        { kind: 'method', name: 'stopModel', signature: '@Remote stopModel(signal: AbortSignal): Promise<LocalRagStatusView>' },
        { kind: 'method', name: 'setModelAutoStart', signature: '@Remote setModelAutoStart(enabled: boolean, signal: AbortSignal): Promise<LocalRagStatusView>' },
        { kind: 'method', name: 'beginUpload', signature: '@Remote beginUpload(request: BeginUploadRequest, signal: AbortSignal): Promise<BeginUploadResult>' },
        { kind: 'method', name: 'appendUpload', signature: '@Remote appendUpload(request: AppendUploadRequest, signal: AbortSignal): Promise<AppendUploadResult>' },
        { kind: 'method', name: 'completeUpload', signature: '@Remote completeUpload(uploadId: string, signal: AbortSignal): Promise<CompleteUploadResult>' },
        { kind: 'method', name: 'cancelUpload', signature: '@Remote cancelUpload(uploadId: string, signal: AbortSignal): Promise<void>' },
        { kind: 'method', name: 'getSourcePreview', signature: '@Remote getSourcePreview(request: GetSourcePreviewRequest, signal: AbortSignal): Promise<GetSourcePreviewResult>' },
        { kind: 'method', name: 'search', signature: '@Remote search(request: SearchLocalMemoryRequest, signal: AbortSignal): Promise<ModelSearchResult>' },
        { kind: 'method', name: 'manual', signature: '@Remote manual(query: string, scope: SearchScope | undefined, signal: AbortSignal): Promise<ModelSearchResult>' },
      ],
      types: [],
      tags: [],
    }],
    events: [],
    objects: [],
  },
}

export default TYPERT
