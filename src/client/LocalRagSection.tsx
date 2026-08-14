import { useEffect, useRef, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SearchScope } from '../contracts.ts'
import type {
  GetSourcePreviewRequest,
  GetSourcePreviewResult,
  LocalRagDocumentContent,
  LocalRagDocumentInfo,
  LocalRagIndexStatus,
  ModelSearchResult,
} from '../host/types.ts'
import type { LocalRagKey } from './locales.ts'
import css from './LocalRagSection.module.css'

const UPLOAD_CHUNK_BYTES = 256 * 1024
const ACCEPTED_FILES = '.pdf,.docx,.tsv,.csv,.txt,.md,.json,.html'

interface ModelOptionView {
  id: string
  name: string
  modelId: string
  dimensions?: number
  installed?: boolean
}

interface ModelDownloadView {
  state: 'idle' | 'downloading' | 'ready' | 'error' | 'cancelled'
  receivedBytes?: number
  totalBytes?: number
  message?: string
}

interface ModelControlView {
  selectedModelId: string
  autoStart: boolean
  runtimeStatus: 'stopped' | 'starting' | 'running' | 'error'
  ready: boolean
  indexRebuildRequired?: boolean
  error?: string
  download: ModelDownloadView
  catalog: readonly ModelOptionView[]
}

interface LocalRagUiStatus {
  enabled: boolean
  index: LocalRagIndexStatus
  model: ModelControlView
  backgroundIndexing: { lastError: string | null }
}

interface UploadStart {
  uploadId: string
  maxChunkBytes: number
}

interface UploadRow {
  key: string
  name: string
  progress: number
  state: 'queued' | 'uploading' | 'complete' | 'failed' | 'cancelled'
  uploadId?: string
  error?: string
}

interface SourcePanelState {
  loading: boolean
  pages: string[]
  preview?: GetSourcePreviewResult
  error?: string
}

export interface LocalRagSectionInjected {
  api: {
    status(): Promise<LocalRagUiStatus>
    listDocuments(sessionId?: string): Promise<readonly LocalRagDocumentInfo[]>
    importText(title: string, text: string): Promise<void>
    getDocument(id: string, sessionId?: string): Promise<LocalRagDocumentContent>
    updateDocument(request: { documentId: string; title: string; text: string; expectedRevision: number; sessionId?: string; reason?: string }): Promise<LocalRagDocumentContent>
    deleteDocument(request: { documentId: string; expectedRevision: number; sessionId?: string; reason?: string }): Promise<void>
    restoreDocument(request: { documentId: string; revision: number; expectedRevision: number; sessionId?: string; reason?: string }): Promise<LocalRagDocumentContent>
    rebuild(): Promise<LocalRagUiStatus>
    search(query: string, scope: SearchScope, sessionId?: string): Promise<ModelSearchResult>
    beginUpload(request: { fileName: string; size: number; mimeType: string; scope: 'knowledge' }): Promise<UploadStart>
    appendUploadChunk(request: { uploadId: string; index: number; offset: number; data: string }): Promise<void>
    completeUpload(uploadId: string): Promise<void>
    cancelUpload(uploadId: string): Promise<void>
    selectModel(modelId: string): Promise<LocalRagUiStatus>
    downloadModel(): Promise<LocalRagUiStatus>
    cancelDownload(): Promise<LocalRagUiStatus>
    startModel(): Promise<LocalRagUiStatus>
    stopModel(): Promise<LocalRagUiStatus>
    setAutoStart(enabled: boolean): Promise<LocalRagUiStatus>
    getSourcePreview(request: GetSourcePreviewRequest): Promise<GetSourcePreviewResult>
  }
  t: (key: LocalRagKey) => string
}

export type LocalRagSectionProps = PropsRuntime<'settings.section'> & Partial<LocalRagSectionInjected>

function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 8192, bytes.length)))
  }
  return btoa(binary)
}

function formatBytes(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function locatorText(hit: ModelSearchResult['hits'][number], t: LocalRagSectionInjected['t']): string {
  const { authority, locator } = hit
  const pieces: string[] = [authority.fileName ?? authority.documentTitle ?? authority.titlePage?.title ?? authority.kind]
  if (locator.pageNumber !== undefined) pieces.push(`${t('page')} ${displayRange(locator.pageNumber, locator.pageEnd)}`)
  if (locator.rowNumber !== undefined) pieces.push(`${t('row')} ${displayRange(locator.rowNumber, locator.rowEnd)}`)
  if (locator.paragraphNumber !== undefined) pieces.push(`${t('paragraph')} ${displayRange(locator.paragraphNumber, locator.paragraphEnd)}`)
  if (locator.lineStart !== undefined) pieces.push(locator.lineEnd !== undefined && locator.lineEnd !== locator.lineStart
    ? `${t('line')} ${locator.lineStart}–${locator.lineEnd}` : `${t('line')} ${locator.lineStart}`)
  if (locator.summaryAt !== undefined) pieces.push(new Date(locator.summaryAt).toLocaleString())
  if (locator.turn !== undefined) pieces.push(`${t('turn')} ${locator.turn}`)
  return pieces.join(' · ')
}

function displayRange(start: number, end?: number): string {
  return end !== undefined && end !== start ? `${start}–${end}` : String(start)
}

export function LocalRagSection({ api, t, useSessions }: LocalRagSectionProps) {
  const currentSessionId = useSessions(state => state.current)
  const [status, setStatus] = useState<LocalRagUiStatus>()
  const [documents, setDocuments] = useState<readonly LocalRagDocumentInfo[]>([])
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<SearchScope>('both')
  const [results, setResults] = useState<ModelSearchResult>()
  const [uploads, setUploads] = useState<UploadRow[]>([])
  const [sourcePanels, setSourcePanels] = useState<Record<string, SourcePanelState>>({})
  const [editing, setEditing] = useState<LocalRagDocumentContent>()
  const [editTitle, setEditTitle] = useState('')
  const [editText, setEditText] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const cancelledUploads = useRef(new Set<string>())
  if (api === undefined || t === undefined) return null

  const refresh = async () => {
    const [nextStatus, nextDocuments] = await Promise.all([api.status(), api.listDocuments(currentSessionId)])
    setStatus(nextStatus)
    setDocuments(nextDocuments)
  }

  useEffect(() => { void refresh().catch(error => setMessage(error instanceof Error ? error.message : String(error))) }, [currentSessionId])
  useEffect(() => {
    if (status?.model.download.state !== 'downloading' && status?.model.runtimeStatus !== 'starting') return
    const timer = window.setInterval(() => { void api.status().then(setStatus).catch(() => undefined) }, 800)
    return () => { window.clearInterval(timer) }
  }, [status?.model.download.state, status?.model.runtimeStatus])

  const run = async (task: () => Promise<void>) => {
    setBusy(true)
    setMessage(t('working'))
    try { await task(); await refresh(); setMessage('') }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }

  const updateUpload = (key: string, change: Partial<UploadRow>) => {
    setUploads(current => current.map(row => row.key === key ? { ...row, ...change } : row))
  }

  const uploadFile = async (file: File, key: string) => {
    let uploadId: string | undefined
    try {
      const start = await api.beginUpload({ fileName: file.name, size: file.size, mimeType: file.type, scope: 'knowledge' })
      uploadId = start.uploadId
      const chunkBytes = Math.max(1, Math.min(UPLOAD_CHUNK_BYTES, start.maxChunkBytes))
      updateUpload(key, { state: 'uploading', uploadId, progress: 0 })
      for (let offset = 0, index = 0; offset < file.size; offset += chunkBytes, index += 1) {
        if (cancelledUploads.current.has(key)) {
          await api.cancelUpload(uploadId)
          updateUpload(key, { state: 'cancelled' })
          return
        }
        const bytes = new Uint8Array(await file.slice(offset, offset + chunkBytes).arrayBuffer())
        await api.appendUploadChunk({ uploadId, index, offset, data: encodeBase64(bytes) })
        updateUpload(key, { progress: Math.min(100, Math.round((offset + bytes.length) / Math.max(1, file.size) * 100)) })
      }
      await api.completeUpload(uploadId)
      updateUpload(key, { state: 'complete', progress: 100 })
    } catch (error) {
      if (uploadId !== undefined) await api.cancelUpload(uploadId).catch(() => undefined)
      updateUpload(key, { state: 'failed', error: error instanceof Error ? error.message : String(error) })
    }
  }

  const chooseFiles = async (files: FileList | null) => {
    if (files === null || files.length === 0) return
    const selected = Array.from(files)
    const rows = selected.map(file => ({ key: crypto.randomUUID(), name: file.name, progress: 0, state: 'queued' as const }))
    setUploads(current => [...rows, ...current].slice(0, 20))
    await Promise.all(selected.map((file, index) => uploadFile(file, rows[index]!.key)))
    await refresh()
  }

  const loadSource = async (key: string, documentId: string, cursor?: number) => {
    setSourcePanels(current => ({ ...current, [key]: { ...current[key], loading: true, pages: current[key]?.pages ?? [], error: undefined } }))
    try {
      const preview = await api.getSourcePreview({ documentId, ...(cursor === undefined ? {} : { cursor }), limit: 16_000 })
      setSourcePanels(current => ({
        ...current,
        [key]: {
          loading: false,
          preview,
          pages: preview.textPage === undefined
            ? current[key]?.pages ?? []
            : [...(cursor === undefined ? [] : current[key]?.pages ?? []), preview.textPage],
        },
      }))
    } catch (error) {
      setSourcePanels(current => ({ ...current, [key]: { ...current[key], loading: false, pages: current[key]?.pages ?? [], error: error instanceof Error ? error.message : String(error) } }))
    }
  }

  const copySourceAddress = async (address: string) => {
    try { await navigator.clipboard.writeText(address); setMessage(t('addressCopied')) }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
  }

  const openDocument = async (documentId: string) => {
    const content = await api.getDocument(documentId, currentSessionId)
    setEditing(content)
    setEditTitle(content.title)
    setEditText(content.text)
  }

  const model = status?.model
  const selectedModel = model?.catalog.find(option => option.id === model.selectedModelId)
  const runtimeLabel = model?.runtimeStatus === 'running' ? t('modelRunning')
    : model?.runtimeStatus === 'starting' ? t('modelStarting')
      : model?.runtimeStatus === 'error' ? t('modelError') : t('modelStopped')
  const runtimeBadge = model?.runtimeStatus === 'running' ? css.ready : model?.runtimeStatus === 'error' ? css.error : css.warning
  const downloadPercent = model?.download.totalBytes && model.download.receivedBytes !== undefined
    ? Math.min(100, Math.round(model.download.receivedBytes / model.download.totalBytes * 100)) : undefined

  return <div className={css.section} data-local-rag-settings>
    <header><h2>{t('title')}</h2><p>{t('intro')}</p></header>
    <section className={`${css.card} ${css.policy}`}><h3>{t('policyTitle')}</h3><p>{t('policy')}</p></section>
    <section className={css.card}>
      <div className={css.cardTitle}><div><h3>{t('model')}</h3><p>{t('modelHint')}</p></div><span className={`${css.badge} ${runtimeBadge}`}>{runtimeLabel}</span></div>
      <div className={css.modelControls}>
        <label>{t('modelSelect')}<select value={model?.selectedModelId ?? ''} disabled={busy || model?.runtimeStatus === 'starting'} onChange={event => void run(async () => { setStatus(await api.selectModel(event.target.value)) })}>
          {(model?.catalog ?? []).map(option => <option value={option.id} key={option.id}>{option.name} · {option.dimensions ?? '—'}D{option.installed ? ` · ${t('installed')}` : ''}</option>)}
        </select></label>
        <div className={css.modelDetail}>{selectedModel?.modelId ?? model?.selectedModelId ?? '—'}</div>
      </div>
      {model?.download.state === 'downloading' && <div className={css.downloadProgress}>
        <div><span>{t('downloading')}</span><span>{downloadPercent === undefined ? `${formatBytes(model.download.receivedBytes)}` : `${downloadPercent}%`}</span></div>
        <progress value={downloadPercent ?? 0} max={100} />
      </div>}
      {(model?.error || model?.download.message) && <span className={`${css.message} ${css.errorText}`}>{model.error ?? model.download.message}</span>}
      {model?.indexRebuildRequired && <span className={`${css.message} ${css.warningText}`}>{t('modelChanged')}</span>}
      <div className={css.toolbar}>
        <button className={`${css.button} ${css.primary}`} disabled={busy || model?.download.state === 'downloading'} onClick={() => { void api.downloadModel().then(setStatus).catch(error => setMessage(String(error))) }}>{t('download')}</button>
        {model?.download.state === 'downloading' && <button className={css.button} onClick={() => { void api.cancelDownload().then(setStatus).catch(error => setMessage(String(error))) }}>{t('cancelDownload')}</button>}
        <button className={css.button} disabled={busy || model?.runtimeStatus === 'running' || model?.runtimeStatus === 'starting'} onClick={() => void run(async () => { setStatus(await api.startModel()) })}>{t('startModel')}</button>
        <button className={css.button} disabled={busy || model?.runtimeStatus !== 'running'} onClick={() => void run(async () => { setStatus(await api.stopModel()) })}>{t('stopModel')}</button>
        <label className={css.checkbox}><input type="checkbox" checked={model?.autoStart ?? false} onChange={event => void run(async () => { setStatus(await api.setAutoStart(event.target.checked)) })} />{t('autoStart')}</label>
      </div>
    </section>
    <section className={css.card}>
      <div className={css.cardTitle}><h3>{t('index')}</h3><span className={`${css.badge} ${status?.index.dirty ? css.warning : css.ready}`}>{status?.index.dirty ? t('lexicalAvailable') : t('healthy')}</span></div>
      <div className={css.metricGrid}>
        <div className={css.metric}><span>{t('documents')}</span><strong>{status?.index.documentCount ?? 0}</strong></div>
        <div className={css.metric}><span>{t('parents')}</span><strong>{status?.index.parentCount ?? 0}</strong></div>
        <div className={css.metric}><span>{t('children')}</span><strong>{status?.index.childCount ?? 0}</strong></div>
      </div>
      <div className={css.toolbar}>
        <button className={css.button} disabled={busy} onClick={() => void run(async () => { setStatus(await api.rebuild()) })}>{t('rebuild')}</button>
        <button className={css.button} disabled={busy} onClick={() => void run(async () => {})}>{t('refresh')}</button>
      </div>
    </section>
    {status?.backgroundIndexing.lastError && <div className={`${css.message} ${css.errorText}`}>{t('backgroundError')}：{status.backgroundIndexing.lastError}</div>}
    <section className={css.card}>
      <div><h3>{t('importTitle')}</h3><p>{t('importHint')}</p></div>
      <label className={css.dropzone}>
        <input type="file" multiple accept={ACCEPTED_FILES} onChange={event => { void chooseFiles(event.target.files); event.target.value = '' }} />
        <strong>{t('chooseFiles')}</strong><span>{t('fileTypes')}</span>
      </label>
      {uploads.length > 0 && <div className={css.uploadList}>{uploads.map(row => <article className={css.uploadRow} key={row.key}>
        <div className={css.uploadHead}><strong>{row.name}</strong><span>{t(`upload_${row.state}` as LocalRagKey)}</span></div>
        <progress value={row.progress} max={100} />
        {row.error && <span className={css.errorText}>{row.error}</span>}
        {(row.state === 'queued' || row.state === 'uploading') && <button className={css.textButton} onClick={() => { cancelledUploads.current.add(row.key); if (row.uploadId) void api.cancelUpload(row.uploadId); updateUpload(row.key, { state: 'cancelled' }) }}>{t('cancelUpload')}</button>}
      </article>)}</div>}
      <details className={css.manualImport}><summary>{t('pasteText')}</summary><div className={css.form}>
        <label>{t('titleLabel')}<input value={title} onChange={event => setTitle(event.target.value)} /></label>
        <label>{t('textLabel')}<textarea rows={5} value={text} onChange={event => setText(event.target.value)} /></label>
        <button className={`${css.button} ${css.primary}`} disabled={busy || !title.trim() || !text.trim()} onClick={() => void run(async () => { await api.importText(title, text); setTitle(''); setText(''); setMessage(t('saved')) })}>{t('import')}</button>
      </div></details>
    </section>
    <section className={css.card}>
      <div><h3>{t('searchTitle')}</h3><p>{t('searchHint')}</p></div>
      <div className={`${css.form} ${css.searchRow}`}>
        <label>{t('query')}<input value={query} onChange={event => setQuery(event.target.value)} /></label>
        <label>{t('scope')}<select value={scope} onChange={event => setScope(event.target.value as SearchScope)}>
          <option value="both">{t('both')}</option><option value="knowledge">{t('knowledge')}</option><option value="conversation_summary">{t('conversationSummary')}</option>
        </select></label>
        <button className={`${css.button} ${css.primary}`} disabled={busy || !query.trim() || (scope === 'conversation_summary' && currentSessionId === undefined)} onClick={() => void run(async () => { setResults(await api.search(query, scope, currentSessionId)) })}>{t('search')}</button>
      </div>
      {results !== undefined && <>
        <div className={css.laneStatus}>
          {(['lexical', 'vector'] as const).map(lane => <span className={`${css.lane} ${results.laneStatus[lane].state !== 'complete' ? css.warning : ''}`} key={lane}>{lane} · {results.laneStatus[lane].state} · {results.laneStatus[lane].candidates}</span>)}
          {results.partial && <span className={`${css.badge} ${css.warning}`}>{t('partial')}</span>}
        </div>
        {results.hits.length === 0 ? <div className={css.empty}>{t('empty')}</div> : <div className={css.results}>{results.hits.map(hit => {
          const panel = sourcePanels[hit.parentId]
          return <article className={css.result} key={hit.parentId}>
          <div className={css.resultMeta}><strong>{hit.title}</strong><span>RRF {hit.rrfScore.toFixed(4)}</span></div>
          <div className={css.sourceLine}><span className={css.sourceKind}>{hit.authority.kind}</span><span>{locatorText(hit, t)}</span></div>
          {hit.sourceUri && <code className={css.sourceAddress}>{hit.sourceUri}</code>}
          <p>{hit.matchedText}</p>
          <div className={css.lanes}>{hit.evidence.map(entry => <span className={css.lane} key={entry.lane}>{entry.lane} #{entry.rank}</span>)}</div>
          <div className={css.sourceActions}>
            <button className={css.textButton} disabled={panel?.loading} onClick={() => {
              if (panel?.preview !== undefined) setSourcePanels(current => { const next = { ...current }; delete next[hit.parentId]; return next })
              else void loadSource(hit.parentId, hit.documentId)
            }}>{panel?.preview !== undefined ? t('closeSource') : panel?.loading ? t('loadingSource') : t('viewSource')}</button>
            {(panel?.preview?.sourceAddress || hit.sourceUri) && <button className={css.textButton} onClick={() => void copySourceAddress(panel?.preview?.sourceAddress ?? hit.sourceUri!)}>{t('copyAddress')}</button>}
          </div>
          {panel?.error && <div className={css.sourceError}>{panel.error}</div>}
          {panel?.preview !== undefined && <section className={css.sourcePreview}>
            <div className={css.sourcePreviewMeta}>
              <strong>{panel.preview.title ?? hit.title}</strong>
              <span>{panel.preview.kind ?? hit.authority.kind}{panel.preview.sourceId ? ` · ${panel.preview.sourceId}` : ''}</span>
              <code>{panel.preview.sourceAddress}</code>
            </div>
            {panel.pages.length > 0 && <pre>{panel.pages.join('\n')}</pre>}
            {panel.pages.length === 0 && <div className={css.binaryNotice}>{panel.preview.canPreview ? t('binarySource') : t('metadataOnly')}</div>}
            {panel.preview.nextCursor !== undefined && <button className={css.button} disabled={panel.loading} onClick={() => void loadSource(hit.parentId, hit.documentId, panel.preview!.nextCursor)}>{panel.loading ? t('loadingSource') : t('loadMore')}</button>}
          </section>}
        </article>})}</div>}
      </>}
    </section>
    <section className={css.card}>
      <div><h3>{t('library')}</h3><p>{t('libraryHint')}</p></div>
      {documents.length === 0 ? <div className={css.empty}>{t('empty')}</div> : <div className={css.list}>{documents.map(document => <article className={`${css.document} ${document.deleted ? css.deletedDocument : ''}`} key={document.id}>
        <div className={css.documentInfo}><strong>{document.title}</strong><span>{document.scope === 'conversation_summary' ? t('conversationSummary') : t('knowledge')} · {document.characters} chars · v{document.revision} · {new Date(document.updatedAt).toLocaleString()}{document.deleted ? ` · ${t('deleted')}` : ''}</span></div>
        <button className={css.button} disabled={busy} onClick={() => void run(async () => { await openDocument(document.id) })}>{document.deleted ? t('history') : t('viewEdit')}</button>
      </article>)}</div>}
      {editing !== undefined && <section className={css.editor}>
        <div className={css.cardTitle}><div><h4>{editing.deleted ? t('deletedDocument') : t('editDocument')}</h4><p>{editing.scope === 'conversation_summary' ? t('summaryGovernanceHint') : t('knowledgeGovernanceHint')}</p></div><button className={css.textButton} onClick={() => setEditing(undefined)}>{t('close')}</button></div>
        <label>{t('titleLabel')}<input value={editTitle} disabled={editing.deleted} onChange={event => setEditTitle(event.target.value)} /></label>
        <label>{t('textLabel')}<textarea rows={12} value={editText} disabled={editing.deleted} onChange={event => setEditText(event.target.value)} /></label>
        <div className={css.toolbar}>
          {!editing.deleted && <button className={`${css.button} ${css.primary}`} disabled={busy || !editTitle.trim() || !editText.trim()} onClick={() => void run(async () => {
            const next = await api.updateDocument({ documentId: editing.documentId, title: editTitle, text: editText, expectedRevision: editing.revision, ...(currentSessionId ? { sessionId: currentSessionId } : {}), reason: t('userEditReason') })
            setEditing(next); setEditTitle(next.title); setEditText(next.text)
          })}>{t('saveRevision')}</button>}
          {!editing.deleted && <button className={css.button} disabled={busy} onClick={() => void run(async () => {
            await api.deleteDocument({ documentId: editing.documentId, expectedRevision: editing.revision, ...(currentSessionId ? { sessionId: currentSessionId } : {}), reason: t('userDeleteReason') })
            setEditing(await api.getDocument(editing.documentId, currentSessionId))
          })}>{t('remove')}</button>}
        </div>
        <div className={css.versionList}><h4>{t('versionHistory')}</h4>{[...editing.versions].reverse().map(version => <article className={css.versionRow} key={version.revision}>
          <div><strong>v{version.revision} · {t(`revision_${version.action}` as LocalRagKey)}</strong><span>{new Date(version.at).toLocaleString()} · {version.characters} chars{version.reason ? ` · ${version.reason}` : ''}</span></div>
          {!version.deleted && version.revision !== editing.revision && <button className={css.button} disabled={busy} onClick={() => void run(async () => {
            const next = await api.restoreDocument({ documentId: editing.documentId, revision: version.revision, expectedRevision: editing.revision, ...(currentSessionId ? { sessionId: currentSessionId } : {}), reason: `${t('restore')} v${version.revision}` })
            setEditing(next); setEditTitle(next.title); setEditText(next.text)
          })}>{t('restore')}</button>}
        </article>)}</div>
      </section>}
    </section>
    {message && <div className={`${css.message} ${message === t('working') || message === t('saved') ? '' : css.errorText}`}>{message}</div>}
  </div>
}
