import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { ModelManifest, ModelSource } from './manifest.ts'
import { ModelDownloadCancelledError, ModelDownloadError, ModelNotReadyError } from './errors.ts'

export type ModelInstallStatus = 'idle' | 'resolving' | 'downloading' | 'verifying' | 'ready' | 'error' | 'cancelled'

export interface RemoteModelFile {
  path: string
  size: number
  sha256: string
  url: string
}

export interface ModelReadyMarker {
  schemaVersion: 1
  modelId: string
  manifestId: string
  source: ModelSource
  installedAt: string
  files: Record<string, { size: number, sha256: string }>
}

export interface ModelInstallState {
  status: ModelInstallStatus
  operationId: string
  modelId: string
  source?: ModelSource
  downloadedBytes: number
  totalBytes: number
  progress: number
  message: string
  error?: string
}

export type ResolveRemoteFiles = (source: ModelSource, manifest: ModelManifest, signal: AbortSignal) => Promise<readonly RemoteModelFile[]>

export interface ModelManagerOptions {
  root: string
  fetch?: typeof fetch
  resolveFiles?: ResolveRemoteFiles
  retriesPerSource?: number
  onState?: (state: Readonly<ModelInstallState>) => void
  /** Local-only load/inference probe run before ready.json is committed. */
  healthCheck?: (target: string, manifest: ModelManifest, signal: AbortSignal) => Promise<void>
}

interface PartialMetadata {
  size: number
  sha256: string
}

const SHA_256 = /^[a-f0-9]{64}$/i

interface DrainableWriter {
  once(event: 'drain', listener: () => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
  off(event: 'drain', listener: () => void): unknown
  off(event: 'error', listener: (error: Error) => void): unknown
}

/**
 * Wait for one backpressure outcome and remove the competing listener. A large
 * model can hit this path thousands of times, so retaining error listeners
 * after successful drains causes MaxListenersExceededWarning.
 */
export function waitForDrainOrError(output: DrainableWriter): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      output.off('drain', onDrain)
      output.off('error', onError)
    }
    const onDrain = () => {
      cleanup()
      resolve()
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    output.once('drain', onDrain)
    output.once('error', onError)
  })
}

function encodeRepoPath(value: string): string {
  return value.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/')
}

function normalizedRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!normalized || normalized.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new ModelDownloadError('unknown', `unsafe remote file path: ${value}`)
  }
  return normalized
}

function isAllowedDownloadUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:'
      || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  } catch {
    return false
  }
}

export function safeModelPath(root: string, relative: string): string {
  const base = path.resolve(root)
  const target = path.resolve(base, relative)
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) {
    throw new ModelDownloadError('unknown', `unsafe target path: ${relative}`)
  }
  return target
}

export async function fileSha256(file: string): Promise<string> {
  const digest = createHash('sha256')
  digest.update(await readFile(file))
  return digest.digest('hex')
}

async function fetchJson(fetchImpl: typeof fetch, url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetchImpl(url, {
    signal,
    headers: { 'User-Agent': 'Mindspace-DSH-Local-RAG/0.1' },
  })
  if (!response.ok) throw new Error(`manifest request failed: HTTP ${response.status}`)
  return response.json()
}

/** Default remote listing parser. Tests may inject ResolveRemoteFiles instead. */
export async function resolveRepositoryFiles(source: ModelSource, manifest: ModelManifest, signal: AbortSignal, fetchImpl: typeof fetch = globalThis.fetch): Promise<readonly RemoteModelFile[]> {
  const revision = source.revision || (source.kind === 'modelscope' ? 'master' : 'main')
  if (source.kind === 'huggingface') {
    const payload = await fetchJson(fetchImpl, `https://huggingface.co/api/models/${source.repo}/tree/${revision}?recursive=true&expand=true`, signal)
    if (!Array.isArray(payload)) throw new Error('Hugging Face returned an invalid repository file listing')
    return payload
      .filter((item: any) => item?.type === 'file' && (!manifest.includeFile || manifest.includeFile(String(item.path || ''))))
      .map((item: any) => ({
        path: normalizedRelativePath(String(item.path || '')),
        size: Number(item.size || item.lfs?.size || 0),
        sha256: String(item.lfs?.oid || '').toLowerCase(),
        url: `https://huggingface.co/${source.repo}/resolve/${revision}/${encodeRepoPath(String(item.path || ''))}`,
      }))
  }
  const payload = await fetchJson(fetchImpl, `https://www.modelscope.cn/api/v1/models/${source.repo}/repo/files?Revision=${encodeURIComponent(revision)}&Recursive=True`, signal) as any
  const files = payload?.Data?.Files
  if (!Array.isArray(files)) throw new Error('ModelScope returned an invalid repository file listing')
  return files
    .filter((item: any) => item?.Type === 'blob' && (!manifest.includeFile || manifest.includeFile(String(item.Path || ''))))
    .map((item: any) => ({
      path: normalizedRelativePath(String(item.Path || '')),
      size: Number(item.Size || 0),
      sha256: String(item.Sha256 || '').toLowerCase(),
      url: `https://www.modelscope.cn/models/${source.repo}/resolve/${revision}/${encodeRepoPath(String(item.Path || ''))}`,
    }))
}

export class LocalModelManager {
  private readonly fetchImpl: typeof fetch
  private readonly resolveFiles: ResolveRemoteFiles
  private readonly retriesPerSource: number
  private readonly states = new Map<string, ModelInstallState>()
  private active?: AbortController

  constructor(private readonly options: ModelManagerOptions) {
    this.fetchImpl = options.fetch || globalThis.fetch
    this.resolveFiles = options.resolveFiles || ((source, manifest, signal) => resolveRepositoryFiles(source, manifest, signal, this.fetchImpl))
    this.retriesPerSource = Math.max(1, options.retriesPerSource ?? 3)
  }

  state(manifest: ModelManifest): Readonly<ModelInstallState> {
    return this.states.get(manifest.id) || {
      status: 'idle', operationId: '', modelId: manifest.modelId,
      downloadedBytes: 0, totalBytes: 0, progress: 0, message: 'waiting for download',
    }
  }

  cancel(): void {
    this.active?.abort()
  }

  targetDir(manifest: ModelManifest): string {
    if (!manifest.targetDir || manifest.targetDir === '.' || path.isAbsolute(manifest.targetDir)) {
      throw new ModelDownloadError(manifest.modelId, 'targetDir must be a non-root relative path')
    }
    return safeModelPath(this.options.root, manifest.targetDir)
  }

  markerPath(manifest: ModelManifest): string {
    return path.join(this.targetDir(manifest), 'ready.json')
  }

  async readMarker(manifest: ModelManifest): Promise<ModelReadyMarker | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.markerPath(manifest), 'utf8')) as ModelReadyMarker
      return parsed?.schemaVersion === 1 && parsed.manifestId === manifest.id && parsed.modelId === manifest.modelId
        ? parsed
        : undefined
    } catch {
      return undefined
    }
  }

  async isReady(manifest: ModelManifest): Promise<boolean> {
    const marker = await this.readMarker(manifest)
    if (!marker) return false
    const target = this.targetDir(manifest)
    for (const required of manifest.required) {
      const relative = normalizedRelativePath(required)
      const expected = marker.files[relative]
      if (!expected) return false
      const file = safeModelPath(target, relative)
      try {
        if ((await stat(file)).size !== expected.size || await fileSha256(file) !== expected.sha256) return false
      } catch {
        return false
      }
    }
    return true
  }

  async assertReady(manifest: ModelManifest): Promise<string> {
    if (!await this.isReady(manifest)) throw new ModelNotReadyError(manifest.modelId)
    return this.targetDir(manifest)
  }

  async download(manifest: ModelManifest, externalSignal?: AbortSignal): Promise<Readonly<ModelInstallState>> {
    if (this.active) throw new ModelDownloadError(manifest.modelId, 'another model operation is already active')
    if (!manifest.sources.length) throw new ModelDownloadError(manifest.modelId, 'manifest has no download sources')

    const controller = new AbortController()
    const relayAbort = () => controller.abort()
    externalSignal?.addEventListener('abort', relayAbort, { once: true })
    if (externalSignal?.aborted) controller.abort()
    this.active = controller
    const operationId = `${manifest.id}-${randomUUID()}`
    this.update(manifest, { status: 'resolving', operationId, downloadedBytes: 0, totalBytes: 0, progress: 0, message: 'resolving local-model manifest' })
    let lastError: unknown
    let calibratedFiles: Map<string, RemoteModelFile> | undefined
    try {
      this.throwIfAborted(manifest, controller.signal)
      // Move the fast-path after the state transition. Callers that deliberately
      // detach this long-running promise (the Web Remote does) can therefore
      // poll a visible `resolving` state immediately instead of seeing idle
      // until the first asynchronous filesystem stat completes.
      if (await this.isReady(manifest)) {
        this.update(manifest, { status: 'ready', operationId: '', downloadedBytes: 0, totalBytes: 0, progress: 100, message: 'model is already verified' })
        return this.state(manifest)
      }
      for (const source of manifest.sources) {
        this.throwIfAborted(manifest, controller.signal)
        try {
          this.update(manifest, { status: 'resolving', operationId, source, message: `resolving ${source.kind} manifest` })
          const files = this.validateFiles(manifest, await this.resolveFiles(source, manifest, controller.signal), calibratedFiles)
          if (source.kind === 'modelscope') calibratedFiles = new Map(files.map(file => [file.path, file]))
          const totalBytes = files.reduce((total, file) => total + file.size, 0)
          this.update(manifest, { status: 'downloading', operationId, source, downloadedBytes: 0, totalBytes, progress: 0, message: `downloading from ${source.kind}` })
          const target = this.targetDir(manifest)
          await mkdir(target, { recursive: true })
          let completed = 0
          for (const file of files) {
            completed += await this.downloadFile(manifest, source, file, target, completed, totalBytes, controller.signal)
          }
          this.update(manifest, { status: 'verifying', operationId, source, downloadedBytes: totalBytes, totalBytes, progress: 99, message: 'verifying installed model' })
          await this.verifyRequired(manifest, target, files)
          await this.options.healthCheck?.(target, manifest, controller.signal)
          await this.writeMarker(manifest, source, target, files)
          this.update(manifest, { status: 'ready', operationId, source, downloadedBytes: totalBytes, totalBytes, progress: 100, message: 'downloaded and verified' })
          return this.state(manifest)
        } catch (error) {
          if (controller.signal.aborted) throw error
          lastError = error
        }
      }
      throw new ModelDownloadError(manifest.modelId, this.describe(lastError), lastError)
    } catch (error) {
      if (controller.signal.aborted || error instanceof ModelDownloadCancelledError) {
        this.update(manifest, { status: 'cancelled', operationId, progress: 0, message: 'download cancelled' })
        throw new ModelDownloadCancelledError(manifest.modelId)
      }
      const failure = error instanceof ModelDownloadError ? error : new ModelDownloadError(manifest.modelId, this.describe(error), error)
      this.update(manifest, { status: 'error', operationId, progress: 0, message: 'download failed', error: failure.message })
      throw failure
    } finally {
      externalSignal?.removeEventListener('abort', relayAbort)
      if (this.active === controller) this.active = undefined
    }
  }

  private update(manifest: ModelManifest, patch: Partial<Omit<ModelInstallState, 'modelId'>>): void {
    const next: ModelInstallState = { ...this.state(manifest), ...patch, modelId: manifest.modelId }
    this.states.set(manifest.id, next)
    this.options.onState?.(next)
  }

  private validateFiles(manifest: ModelManifest, files: readonly RemoteModelFile[], calibratedFiles?: ReadonlyMap<string, RemoteModelFile>): RemoteModelFile[] {
    const seen = new Set<string>()
    const valid = files.map((file) => {
      const remotePath = normalizedRelativePath(file.path)
      const mappedPath = manifest.localFileMap?.[remotePath]
      const relative = normalizedRelativePath(mappedPath === undefined ? remotePath : mappedPath)
      if (seen.has(relative)) throw new ModelDownloadError(manifest.modelId, `remote listing repeats ${relative}`)
      seen.add(relative)
      const trusted = manifest.trustedFiles?.[relative]
      const calibrated = calibratedFiles?.get(relative)
      const size = Number(file.size || trusted?.size || calibrated?.size || 0)
      const sha256 = String(file.sha256 || trusted?.sha256 || calibrated?.sha256 || '').toLowerCase()
      if (!Number.isSafeInteger(size) || size <= 0) throw new ModelDownloadError(manifest.modelId, `invalid size for ${relative}`)
      if (trusted?.size && trusted.size !== size) throw new ModelDownloadError(manifest.modelId, `trusted size mismatch for ${relative}`)
      if (calibrated?.size && calibrated.size !== size) throw new ModelDownloadError(manifest.modelId, `cross-source size mismatch for ${relative}`)
      if (!SHA_256.test(sha256)) throw new ModelDownloadError(manifest.modelId, `missing trusted SHA-256 for ${relative}`)
      if (trusted?.sha256 && trusted.sha256.toLowerCase() !== sha256) throw new ModelDownloadError(manifest.modelId, `trusted SHA-256 mismatch for ${relative}`)
      if (calibrated?.sha256 && calibrated.sha256 !== sha256) throw new ModelDownloadError(manifest.modelId, `cross-source SHA-256 mismatch for ${relative}`)
      if (!isAllowedDownloadUrl(file.url)) throw new ModelDownloadError(manifest.modelId, `invalid download URL for ${relative}`)
      return { ...file, path: relative, size, sha256 }
    })
    for (const required of manifest.required) {
      if (!seen.has(normalizedRelativePath(required))) throw new ModelDownloadError(manifest.modelId, `remote listing misses required file ${required}`)
    }
    return valid
  }

  private async downloadFile(manifest: ModelManifest, source: ModelSource, file: RemoteModelFile, targetRoot: string, completedBytes: number, totalBytes: number, signal: AbortSignal): Promise<number> {
    let lastError: unknown
    for (let attempt = 1; attempt <= this.retriesPerSource; attempt += 1) {
      try {
        return await this.downloadFileOnce(manifest, source, file, targetRoot, completedBytes, totalBytes, signal)
      } catch (error) {
        if (signal.aborted) throw error
        lastError = error
      }
    }
    throw lastError
  }

  private async downloadFileOnce(manifest: ModelManifest, source: ModelSource, file: RemoteModelFile, targetRoot: string, completedBytes: number, totalBytes: number, signal: AbortSignal): Promise<number> {
    const target = safeModelPath(targetRoot, file.path)
    const partial = `${target}.partial`
    const metadataFile = `${partial}.json`
    await mkdir(path.dirname(target), { recursive: true })
    if (await this.matches(target, file)) return file.size

    let offset = 0
    if (existsSync(partial)) {
      const metadata = await this.readPartialMetadata(metadataFile)
      if (metadata?.size === file.size && metadata.sha256 === file.sha256 && (await stat(partial)).size <= file.size) offset = (await stat(partial)).size
      else {
        await rm(partial, { force: true })
        await rm(metadataFile, { force: true })
      }
    }
    if (offset === 0) await writeFile(metadataFile, JSON.stringify({ size: file.size, sha256: file.sha256 } satisfies PartialMetadata))

    const response = await this.fetchWithRange(file.url, offset, signal)
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
    if (offset && response.status !== 206) {
      await rm(partial, { force: true })
      offset = 0
      await writeFile(metadataFile, JSON.stringify({ size: file.size, sha256: file.sha256 } satisfies PartialMetadata))
      const restart = await this.fetchWithRange(file.url, 0, signal)
      if (!restart.ok || !restart.body) throw new Error(`HTTP ${restart.status}`)
      return this.streamToPartial(manifest, source, file, target, partial, metadataFile, restart, 0, completedBytes, totalBytes, signal)
    }
    return this.streamToPartial(manifest, source, file, target, partial, metadataFile, response, offset, completedBytes, totalBytes, signal)
  }

  private async fetchWithRange(url: string, offset: number, signal: AbortSignal): Promise<Response> {
    return this.fetchImpl(url, {
      signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mindspace-DSH-Local-RAG/0.1', ...(offset ? { Range: `bytes=${offset}-` } : {}) },
    })
  }

  private async streamToPartial(manifest: ModelManifest, source: ModelSource, file: RemoteModelFile, target: string, partial: string, metadataFile: string, response: Response, offset: number, completedBytes: number, totalBytes: number, signal: AbortSignal): Promise<number> {
    const output = createWriteStream(partial, { flags: offset ? 'a' : 'w' })
    let received = offset
    try {
      for await (const rawChunk of response.body as any as AsyncIterable<Uint8Array>) {
        this.throwIfAborted(manifest, signal)
        const chunk = Buffer.from(rawChunk)
        received += chunk.length
        if (received > file.size) throw new Error(`${file.path} exceeds manifest size`)
        if (!output.write(chunk)) await waitForDrainOrError(output)
        this.update(manifest, {
          status: 'downloading', operationId: this.state(manifest).operationId, source,
          downloadedBytes: completedBytes + received, totalBytes,
          progress: totalBytes ? Math.min(99, (completedBytes + received) / totalBytes * 100) : 0,
          message: `downloading ${file.path}`,
        })
      }
      await new Promise<void>((resolve, reject) => output.end((error: Error | null | undefined) => error ? reject(error) : resolve()))
    } catch (error) {
      output.destroy()
      throw error
    }
    if (received !== file.size) throw new Error(`${file.path} size mismatch: ${received}/${file.size}`)
    this.update(manifest, { status: 'verifying', operationId: this.state(manifest).operationId, source, downloadedBytes: completedBytes + received, totalBytes, progress: 99, message: `verifying ${file.path}` })
    if (await fileSha256(partial) !== file.sha256) {
      await rm(partial, { force: true })
      await rm(metadataFile, { force: true })
      throw new Error(`${file.path} SHA-256 mismatch`)
    }
    await rm(target, { force: true })
    await rename(partial, target)
    await rm(metadataFile, { force: true })
    return file.size
  }

  private async verifyRequired(manifest: ModelManifest, target: string, files: readonly RemoteModelFile[]): Promise<void> {
    const expected = new Map(files.map(file => [file.path, file]))
    for (const required of manifest.required) {
      const file = expected.get(normalizedRelativePath(required))
      if (!file || !await this.matches(safeModelPath(target, file.path), file)) {
        throw new ModelDownloadError(manifest.modelId, `verification failed for required file ${required}`)
      }
    }
  }

  private async writeMarker(manifest: ModelManifest, source: ModelSource, target: string, files: readonly RemoteModelFile[]): Promise<void> {
    const marker: ModelReadyMarker = {
      schemaVersion: 1,
      manifestId: manifest.id,
      modelId: manifest.modelId,
      source,
      installedAt: new Date().toISOString(),
      files: Object.fromEntries(files.map(file => [file.path, { size: file.size, sha256: file.sha256 }])),
    }
    const temporary = path.join(target, `ready.json.${randomUUID()}.partial`)
    await writeFile(temporary, `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
    await rename(temporary, this.markerPath(manifest))
  }

  private async matches(file: string, expected: RemoteModelFile): Promise<boolean> {
    try {
      return (await stat(file)).size === expected.size && await fileSha256(file) === expected.sha256
    } catch {
      return false
    }
  }

  private async readPartialMetadata(file: string): Promise<PartialMetadata | undefined> {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as PartialMetadata
      return Number.isSafeInteger(parsed.size) && SHA_256.test(parsed.sha256) ? parsed : undefined
    } catch {
      return undefined
    }
  }

  private throwIfAborted(manifest: ModelManifest, signal: AbortSignal): void {
    if (signal.aborted) throw new ModelDownloadCancelledError(manifest.modelId)
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error || 'unknown error')
  }
}
