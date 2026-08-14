import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createServer, type RequestListener } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ModelDownloadCancelledError, ModelDownloadError } from '../src/model/errors.ts'
import { LocalModelManager, type RemoteModelFile, waitForDrainOrError } from '../src/model/manager.ts'
import type { ModelManifest, ModelSource } from '../src/model/manifest.ts'

const temporaryRoots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mindspace-dsh-local-rag-model-'))
  temporaryRoots.push(root)
  return root
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function manifest(): ModelManifest {
  return {
    id: 'fixture-embedding',
    modelId: 'fixture/embedding',
    targetDir: 'models/fixture',
    required: ['weights.bin'],
    sources: [
      { kind: 'modelscope', repo: 'fixture/domestic' },
      { kind: 'huggingface', repo: 'fixture/official' },
    ],
  }
}

async function withServer(handler: RequestListener): Promise<{ origin: string, close: () => Promise<void> }> {
  const server = createServer(handler)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server did not expose a TCP address')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('LocalModelManager', () => {
  it('cleans competing drain/error listeners after every backpressure cycle', async () => {
    const output = new EventEmitter()
    for (let index = 0; index < 64; index += 1) {
      const waiting = waitForDrainOrError(output)
      expect(output.listenerCount('drain')).toBe(1)
      expect(output.listenerCount('error')).toBe(1)
      output.emit('drain')
      await waiting
      expect(output.listenerCount('drain')).toBe(0)
      expect(output.listenerCount('error')).toBe(0)
    }
  })

  it('also removes the drain listener when a backpressure write errors', async () => {
    const output = new EventEmitter()
    const waiting = waitForDrainOrError(output)
    output.emit('error', new Error('disk failure'))
    await expect(waiting).rejects.toThrow('disk failure')
    expect(output.listenerCount('drain')).toBe(0)
    expect(output.listenerCount('error')).toBe(0)
  })

  it('falls back from ModelScope, resumes a compatible partial, verifies, and writes ready.json', async () => {
    const content = Buffer.from('a locally downloaded embedding artifact'.repeat(8))
    const digest = sha256(content)
    let rangeHeader = ''
    const server = await withServer((request, response) => {
      if (request.url === '/domestic/weights.bin') {
        response.writeHead(503).end('domestic mirror unavailable')
        return
      }
      if (request.url !== '/official/weights.bin') {
        response.writeHead(404).end()
        return
      }
      rangeHeader = String(request.headers.range || '')
      const match = /^bytes=(\d+)-$/.exec(rangeHeader)
      const offset = match ? Number(match[1]) : 0
      response.writeHead(offset ? 206 : 200, {
        'Content-Length': content.length - offset,
        ...(offset ? { 'Content-Range': `bytes ${offset}-${content.length - 1}/${content.length}` } : {}),
      })
      response.end(content.subarray(offset))
    })
    try {
      const root = await temporaryRoot()
      const target = path.join(root, 'models', 'fixture')
      await writeFile(path.join(root, 'placeholder'), '')
      await mkdir(target, { recursive: true })
      await writeFile(path.join(target, 'weights.bin.partial'), content.subarray(0, 13))
      await writeFile(path.join(target, 'weights.bin.partial.json'), JSON.stringify({ size: content.length, sha256: digest }))

      const filesFor = (source: ModelSource): readonly RemoteModelFile[] => [{
        // Hugging Face does not consistently expose hashes for small files;
        // the manager must reuse the trusted domestic manifest hash.
        path: 'weights.bin', size: content.length, sha256: source.kind === 'modelscope' ? digest : '',
        url: `${server.origin}/${source.kind === 'modelscope' ? 'domestic' : 'official'}/weights.bin`,
      }]
      const manager = new LocalModelManager({ root, resolveFiles: async source => filesFor(source) })
      const result = await manager.download(manifest())

      expect(result.status).toBe('ready')
      expect(result.source?.kind).toBe('huggingface')
      expect(rangeHeader).toBe('bytes=13-')
      expect(await readFile(path.join(target, 'weights.bin'))).toEqual(content)
      expect(await manager.isReady(manifest())).toBe(true)
      const marker = JSON.parse(await readFile(path.join(target, 'ready.json'), 'utf8'))
      expect(marker.source.kind).toBe('huggingface')
      await expect(stat(path.join(target, 'weights.bin.partial'))).rejects.toThrow()
    } finally {
      await server.close()
    }
  })

  it('restarts at byte zero when a server ignores Range', async () => {
    const content = Buffer.from('range fallback payload')
    const digest = sha256(content)
    let requests = 0
    const server = await withServer((request, response) => {
      requests += 1
      expect(request.headers.range).toBe(requests === 1 ? 'bytes=4-' : undefined)
      response.writeHead(200, { 'Content-Length': content.length }).end(content)
    })
    try {
      const root = await temporaryRoot()
      const target = path.join(root, 'models', 'fixture')
      await mkdir(target, { recursive: true })
      await writeFile(path.join(target, 'weights.bin.partial'), content.subarray(0, 4))
      await writeFile(path.join(target, 'weights.bin.partial.json'), JSON.stringify({ size: content.length, sha256: digest }))
      const manager = new LocalModelManager({
        root,
        resolveFiles: async () => [{ path: 'weights.bin', size: content.length, sha256: digest, url: `${server.origin}/weights.bin` }],
      })
      await manager.download({ ...manifest(), sources: [{ kind: 'modelscope', repo: 'fixture' }] })
      expect(requests).toBe(2)
      expect(await readFile(path.join(target, 'weights.bin'))).toEqual(content)
    } finally {
      await server.close()
    }
  })

  it('maps an ONNX-side tokenizer into the root path expected by Transformers.js before writing ready.json', async () => {
    const root = await temporaryRoot()
    const content = Buffer.from('{"version":"1.0"}')
    const digest = sha256(content)
    const fixture = {
      ...manifest(),
      required: ['tokenizer.json'],
      localFileMap: { 'onnx/tokenizer.json': 'tokenizer.json' },
      sources: [{ kind: 'modelscope' as const, repo: 'fixture' }],
    }
    const manager = new LocalModelManager({
      root,
      resolveFiles: async () => [{ path: 'onnx/tokenizer.json', size: content.length, sha256: digest, url: 'https://fixture.test/onnx/tokenizer.json' }],
      fetch: async () => new Response(content, { status: 200 }),
    })

    await manager.download(fixture)
    expect(await readFile(path.join(root, 'models', 'fixture', 'tokenizer.json'))).toEqual(content)
    await expect(stat(path.join(root, 'models', 'fixture', 'onnx', 'tokenizer.json'))).rejects.toThrow()
    await expect(manager.isReady(fixture)).resolves.toBe(true)
  })

  it('rejects unsafe paths and never writes outside the model root', async () => {
    const root = await temporaryRoot()
    const manager = new LocalModelManager({
      root,
      resolveFiles: async () => [{ path: '../escape.bin', size: 1, sha256: 'a'.repeat(64), url: 'https://example.test/escape.bin' }],
    })
    await expect(manager.download({ ...manifest(), sources: [{ kind: 'modelscope', repo: 'fixture' }] })).rejects.toBeInstanceOf(ModelDownloadError)
    await expect(stat(path.join(root, 'escape.bin'))).rejects.toThrow()
  })

  it('does not mark a checksum mismatch as ready', async () => {
    const root = await temporaryRoot()
    const manager = new LocalModelManager({
      root,
      retriesPerSource: 1,
      resolveFiles: async () => [{ path: 'weights.bin', size: 3, sha256: 'a'.repeat(64), url: 'https://fixture.test/weights.bin' }],
      fetch: async () => new Response('bad', { status: 200 }),
    })
    await expect(manager.download({ ...manifest(), sources: [{ kind: 'modelscope', repo: 'fixture' }] })).rejects.toBeInstanceOf(ModelDownloadError)
    await expect(manager.isReady(manifest())).resolves.toBe(false)
  })

  it('does not commit ready.json when the local inference health check fails', async () => {
    const root = await temporaryRoot()
    const content = Buffer.from('valid artifact with an invalid runtime')
    const digest = sha256(content)
    const checked = vi.fn(async () => { throw new Error('ONNX probe failed') })
    const manager = new LocalModelManager({
      root,
      retriesPerSource: 1,
      resolveFiles: async () => [{
        path: 'weights.bin', size: content.length, sha256: digest,
        url: 'https://fixture.test/weights.bin',
      }],
      fetch: async () => new Response(content, { status: 200 }),
      healthCheck: checked,
    })
    const fixture = { ...manifest(), sources: [{ kind: 'modelscope' as const, repo: 'fixture' }] }

    await expect(manager.download(fixture)).rejects.toThrow('ONNX probe failed')
    expect(checked).toHaveBeenCalledOnce()
    await expect(manager.isReady(fixture)).resolves.toBe(false)
    await expect(stat(manager.markerPath(fixture))).rejects.toThrow()
  })

  it('refuses a hashless official listing unless it was calibrated or pinned', async () => {
    const root = await temporaryRoot()
    const manager = new LocalModelManager({
      root,
      resolveFiles: async () => [{ path: 'weights.bin', size: 3, sha256: '', url: 'https://example.test/weights.bin' }],
    })
    const officialOnly = { ...manifest(), sources: [{ kind: 'huggingface' as const, repo: 'fixture/official' }] }
    await expect(manager.download(officialOnly)).rejects.toThrow('missing trusted SHA-256')
    await expect(manager.isReady(officialOnly)).resolves.toBe(false)
  })

  it('reports cancellation as a distinct non-ready state', async () => {
    const root = await temporaryRoot()
    const controller = new AbortController()
    controller.abort()
    const manager = new LocalModelManager({ root, resolveFiles: async () => [] })
    await expect(manager.download(manifest(), controller.signal)).rejects.toBeInstanceOf(ModelDownloadCancelledError)
    expect(manager.state(manifest()).status).toBe('cancelled')
  })
})
