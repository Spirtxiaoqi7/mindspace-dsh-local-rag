import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import localRagRemote from '../generated/remote.ts'
import type { SearchScope } from '../contracts.ts'
import type { LocalRagModelCatalogItem, LocalRagStatusView } from '../host/types.ts'
import { LocalRagSection, type LocalRagSectionInjected } from './LocalRagSection.tsx'
import { en, zh, type LocalRagKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'settings.localRag': LocalRagKey }
}

type Wrapped<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { code: string; message: string } }

export const inject = ['slots', 'locale', 'remote']

export async function apply(ctx: ClientContext): Promise<void> {
  try {
    const disposeRemote = await ctx.remote.$mount(localRagRemote)
    ctx.effect(() => disposeRemote, 'mindspace-local-rag: remote')
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes('localRag/') || !message.includes('already mounted')) throw error
  }
  const ns = 'settings.localRag'
  ctx.effect(() => ctx.locale.register(ns, { zh, en }), 'mindspace-local-rag: dictionaries')
  const t = ctx.locale.bind(ns) as LocalRagSectionInjected['t']
  const remote = ctx.get('remote.localRag') as unknown as Record<string, (...args: unknown[]) => Promise<Wrapped<unknown>>>
  if (remote === undefined) throw new Error('mindspace-local-rag: mounted Remote namespace is unavailable')
  const call = async <T>(method: string, ...args: unknown[]): Promise<T> => {
    const response = await remote[method]!(...args) as Wrapped<T>
    if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
    return response.value
  }
  type UiStatus = Awaited<ReturnType<LocalRagSectionInjected['api']['status']>>
  type Catalog = UiStatus['model']['catalog']
  const status = async (): Promise<UiStatus> => {
    const [view, catalog] = await Promise.all([
      call<LocalRagStatusView>('status'),
      call<readonly LocalRagModelCatalogItem[]>('catalogModels'),
    ])
    const options = view.model.catalog ?? catalog
    return {
      enabled: view.enabled,
      index: view.index,
      backgroundIndexing: view.backgroundIndexing,
      model: {
        selectedModelId: view.model.selectedModelId ?? options[0]?.id ?? '',
        autoStart: view.model.autoStart ?? false,
        runtimeStatus: view.model.running ? 'running' : view.model.state === 'error' ? 'error' : 'stopped',
        ready: view.model.ready,
        indexRebuildRequired: view.model.indexRebuildRequired,
        ...(view.model.state === 'error' && view.model.message ? { error: view.model.message } : {}),
        download: {
          state: view.model.state === 'downloading' ? 'downloading' : view.model.state === 'error' ? 'error' : 'idle',
          ...(view.model.message ? { message: view.model.message } : {}),
        },
        catalog: options.map(item => ({
          id: item.id,
          name: item.name ?? item.modelId,
          modelId: item.modelId,
          ...(item.dimensions === undefined ? {} : { dimensions: item.dimensions }),
        })) satisfies Catalog,
      },
    }
  }
  const mutateAndRefresh = async (method: string, ...args: unknown[]): Promise<UiStatus> => {
    await call(method, ...args)
    return status()
  }
  const api: LocalRagSectionInjected['api'] = {
    status,
    listDocuments: (sessionId?: string) => call('listDocuments', sessionId === undefined ? { scope: 'knowledge' } : { scope: 'both', sessionId }),
    importText: async (title, text) => { await call('importText', { title, text, scope: 'knowledge', source: 'manual' }) },
    getDocument: (id, sessionId) => call('getDocument', { documentId: id, ...(sessionId === undefined ? {} : { sessionId }) }),
    updateDocument: request => call('updateDocument', request),
    deleteDocument: async request => { await call('deleteDocument', request) },
    restoreDocument: request => call('restoreDocument', request),
    rebuild: () => mutateAndRefresh('rebuild'),
    search: (query: string, scope: SearchScope, sessionId?: string) => call('search', {
      query,
      scope,
      ...(sessionId === undefined ? {} : { sessionId }),
    }),
    beginUpload: request => call('beginUpload', {
      fileName: request.fileName,
      size: request.size,
      source: request.mimeType || 'application/octet-stream',
    }),
    appendUploadChunk: async request => { await call('appendUpload', {
      uploadId: request.uploadId,
      offset: request.offset,
      dataBase64: request.data,
    }) },
    completeUpload: async uploadId => { await call('completeUpload', uploadId) },
    cancelUpload: async uploadId => { await call('cancelUpload', uploadId) },
    selectModel: modelId => mutateAndRefresh('selectModel', modelId),
    downloadModel: () => mutateAndRefresh('downloadModel', undefined),
    cancelDownload: () => mutateAndRefresh('cancelDownload'),
    startModel: () => mutateAndRefresh('startModel'),
    stopModel: () => mutateAndRefresh('stopModel'),
    setAutoStart: enabled => mutateAndRefresh('setModelAutoStart', enabled),
    getSourcePreview: request => call('getSourcePreview', request),
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'local-rag', order: 25, label: () => t('nav'),
    inject: (): LocalRagSectionInjected => ({ api, t }),
  }, LocalRagSection))
}
