/* Checked-in strict Remote descriptors for the standalone DSH plugin. */
import { z } from 'zod'

const documentScope = z.union([z.literal('conversation_summary'), z.literal('knowledge')])
const scope = z.union([documentScope, z.literal('both')])
const authority = z.object({
  kind: z.string(), fileName: z.string().optional(), documentTitle: z.string().optional(),
  author: z.string().optional(), url: z.string().optional(), source: z.string().optional(),
  titlePage: z.object({ pageNumber: z.number(), title: z.string().optional(), text: z.string() }).optional(),
})
const locator = z.object({
  pageNumber: z.number().optional(), pageEnd: z.number().optional(), paragraphNumber: z.number().optional(), paragraphEnd: z.number().optional(), rowNumber: z.number().optional(), rowEnd: z.number().optional(),
  lineStart: z.number().optional(), lineEnd: z.number().optional(), heading: z.string().optional(),
  header: z.array(z.string()).optional(), summaryAt: z.number().optional(), turn: z.number().optional(),
  seqStart: z.number().optional(), seqEnd: z.number().optional(),
})
const documentInfo = z.object({
  id: z.string(), title: z.string(), scope: documentScope,
  sessionId: z.string().optional(), sourceId: z.string().optional(), sourceUri: z.string().optional(), source: z.string().optional(), updatedAt: z.number(), characters: z.number(),
  deleted: z.boolean().optional(), revision: z.number(), revisionCount: z.number(),
})
const revisionAction = z.union([z.literal('created'), z.literal('edited'), z.literal('deleted'), z.literal('restored')])
const revisionInfo = z.object({ revision: z.number(), action: revisionAction, at: z.number(), reason: z.string().optional(), title: z.string().optional(), characters: z.number(), deleted: z.boolean() })
const documentContent = z.object({
  documentId: z.string(), title: z.string(), text: z.string(), scope: documentScope,
  sessionId: z.string().optional(), sourceId: z.string().optional(), sourceUri: z.string().optional(), source: z.string().optional(),
  updatedAt: z.number(), revision: z.number(), deleted: z.boolean(), versions: z.array(revisionInfo),
})
const getDocumentRequest = z.object({ documentId: z.string(), sessionId: z.string().optional() })
const updateDocumentRequest = z.object({ documentId: z.string(), title: z.string(), text: z.string(), expectedRevision: z.number(), sessionId: z.string().optional(), reason: z.string().optional() })
const deleteDocumentRequest = z.object({ documentId: z.string(), expectedRevision: z.number(), sessionId: z.string().optional(), reason: z.string().optional() })
const restoreDocumentRequest = z.object({ documentId: z.string(), revision: z.number(), expectedRevision: z.number(), sessionId: z.string().optional(), reason: z.string().optional() })
const catalogItem = z.object({
  id: z.string(), modelId: z.string(), name: z.string().optional(), dimensions: z.number().optional(),
})
const status = z.object({
  enabled: z.boolean(),
  index: z.object({
    documentCount: z.number(), parentCount: z.number(), childCount: z.number(), dirty: z.boolean(),
    updatedAt: z.union([z.null(), z.number()]),
  }),
  model: z.object({
    modelId: z.string(), ready: z.boolean(), dimensions: z.union([z.null(), z.number()]),
    state: z.union([z.literal('ready'), z.literal('missing'), z.literal('downloading'), z.literal('error')]),
    message: z.string().optional(), selectedModelId: z.string().optional(), autoStart: z.boolean().optional(),
    running: z.boolean().optional(), indexRebuildRequired: z.boolean().optional(), catalog: z.array(catalogItem).optional(),
  }),
  backgroundIndexing: z.object({
    lastDocumentId: z.union([z.null(), z.string()]), lastIndexedAt: z.union([z.null(), z.number()]),
    lastError: z.union([z.null(), z.string()]),
  }),
})
const laneStatus = z.object({
  lane: z.union([z.literal('vector'), z.literal('lexical')]),
  state: z.union([z.literal('complete'), z.literal('empty'), z.literal('unavailable'), z.literal('stale_model'), z.literal('timeout'), z.literal('error')]),
  candidates: z.number(), detail: z.string().optional(),
})
const searchRequest = z.object({ query: z.string(), scope: scope.optional(), sessionId: z.string().optional(), documentId: z.string().optional(), sourceId: z.string().optional() })
const searchResult = z.object({
  query: z.string(), scope, vectorCandidates: z.number(), lexicalCandidates: z.number(), modelId: z.string(),
  laneStatus: z.object({ vector: laneStatus, lexical: laneStatus }), partial: z.boolean(),
  hits: z.array(z.object({
    parentId: z.string(), documentId: z.string(), title: z.string(), text: z.string(), matchedText: z.string(),
    scope: documentScope, sourceId: z.string().optional(), sourceUri: z.string().optional(), source: z.string().optional(), authority, locator,
    updatedAt: z.number(), rrfScore: z.number(),
    evidence: z.array(z.object({
      lane: z.union([z.literal('vector'), z.literal('lexical')]), rank: z.number(), score: z.number(),
    })),
  })),
})
const importRequest = z.object({
  id: z.string().optional(), title: z.string(), text: z.string(), scope: documentScope,
  sessionId: z.string().optional(), source: z.string().optional(),
})
const listRequest = z.object({ scope: scope.optional(), sessionId: z.string().optional() })
const beginUploadRequest = z.object({
  fileName: z.string(), size: z.number(), url: z.string().optional(), source: z.string().optional(),
})
const beginUploadResult = z.object({ uploadId: z.string(), maxChunkBytes: z.number() })
const appendUploadRequest = z.object({ uploadId: z.string(), offset: z.number(), dataBase64: z.string() })
const appendUploadResult = z.object({ receivedBytes: z.number(), complete: z.boolean() })
const completeUploadResult = z.object({ documentId: z.string(), title: z.string(), characters: z.number(), sourceId: z.string(), sourceUri: z.string() })
const sourcePreviewRequest = z.object({ documentId: z.string(), cursor: z.number().optional(), limit: z.number().optional() })
const sourcePreviewResult = z.object({
  documentId: z.string(), sourceId: z.string().optional(), sourceUri: z.string().optional(), kind: z.string().optional(),
  title: z.string().optional(), sourceAddress: z.string(), textPage: z.string().optional(), offset: z.number().optional(),
  nextCursor: z.number().optional(), canPreview: z.boolean(),
})

function codec(typeSymbol: string, schema: z.ZodType) {
  return { mode: 'strict' as const, typeSymbol, schema }
}

function json(name: string, schema: z.ZodType, acceptsUndefined = false) {
  return {
    name, wire: name, source: 'json' as const,
    codec: codec(`mindspace-dsh-local-rag#localRag/${name}`, schema),
    ...(acceptsUndefined ? { acceptsUndefined: true as const } : {}),
  }
}

function invocation(method: string, parameters: ReturnType<typeof json>[], resultSchema: z.ZodType) {
  return {
    id: `mindspace-dsh-local-rag#localRag/${method}`,
    service: 'localRag', namespace: 'localRag', method,
    invocation: { kind: 'direct' as const }, parameters,
    cancellation: { parameter: 'signal' as const },
    result: codec(`mindspace-dsh-local-rag#localRag/${method}:result`, resultSchema),
  }
}

export const localRagDescriptors = [
  invocation('status', [], status),
  invocation('importText', [json('request', importRequest)], z.object({ documentId: z.string() })),
  invocation('removeDocument', [json('documentId', z.string())], z.object({ removed: z.boolean() })),
  invocation('deleteDocument', [json('request', deleteDocumentRequest)], z.object({ removed: z.boolean() })),
  invocation('listDocuments', [json('request', listRequest)], z.array(documentInfo)),
  invocation('getDocument', [json('request', getDocumentRequest)], documentContent),
  invocation('updateDocument', [json('request', updateDocumentRequest)], documentContent),
  invocation('restoreDocument', [json('request', restoreDocumentRequest)], documentContent),
  invocation('rebuild', [], status),
  invocation('catalogModels', [], z.array(catalogItem)),
  invocation('selectModel', [json('modelId', z.string())], status),
  invocation('downloadModel', [json('modelId', z.union([z.undefined(), z.string()]), true)], status),
  invocation('cancelDownload', [], status),
  invocation('startModel', [], status),
  invocation('stopModel', [], status),
  invocation('setModelAutoStart', [json('enabled', z.boolean())], status),
  invocation('beginUpload', [json('request', beginUploadRequest)], beginUploadResult),
  invocation('appendUpload', [json('request', appendUploadRequest)], appendUploadResult),
  invocation('completeUpload', [json('uploadId', z.string())], completeUploadResult),
  invocation('cancelUpload', [json('uploadId', z.string())], z.undefined()),
  invocation('getSourcePreview', [json('request', sourcePreviewRequest)], sourcePreviewResult),
  invocation('search', [json('request', searchRequest)], searchResult),
  invocation('manual', [json('query', z.string()), json('scope', z.union([z.undefined(), scope]), true)], searchResult),
] as const

export const localRagSchemas = {
  status, searchRequest, searchResult, importRequest, listRequest, documentInfo, documentContent, getDocumentRequest, updateDocumentRequest, deleteDocumentRequest, restoreDocumentRequest, revisionInfo, catalogItem,
  beginUploadRequest, beginUploadResult, appendUploadRequest, appendUploadResult, completeUploadResult, sourcePreviewRequest, sourcePreviewResult,
}
