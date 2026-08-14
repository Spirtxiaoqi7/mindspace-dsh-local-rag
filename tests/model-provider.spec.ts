import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { TransformersJsLocalEmbeddingProvider } from '../src/model/embedding-provider.ts'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('TransformersJsLocalEmbeddingProvider', () => {
  it('uses a dynamic local-only module and returns normalized vectors', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'mindspace-dsh-transformers-'))
    directories.push(directory)
    await mkdir(directory, { recursive: true })
    const env: { allowLocalModels?: boolean, allowRemoteModels?: boolean, localModelPath?: string } = {}
    let receivedModel = ''
    let receivedOptions: Record<string, unknown> | undefined
    const provider = new TransformersJsLocalEmbeddingProvider({
      modelId: 'fixture/local',
      modelDirectory: directory,
      loadModule: async () => ({
        env,
        pipeline: async (_task, model, options) => {
          receivedModel = model
          receivedOptions = options
          return async () => ({ data: [3, 4, 0, 5], dims: [2, 2] })
        },
      }),
    })

    expect(await provider.ready()).toBe(true)
    await expect(provider.embed(['first', 'second'])).resolves.toEqual([[0.6, 0.8], [0, 1]])
    expect(provider.dimensions).toBe(2)
    expect(env.allowLocalModels).toBe(true)
    expect(env.allowRemoteModels).toBe(false)
    expect(receivedModel).toBe(path.basename(directory))
    expect(env.localModelPath).toBe(path.dirname(path.resolve(directory)))
    expect(receivedOptions).toMatchObject({ local_files_only: true })
  })

  it('enforces a configured embedding dimension without accessing a remote model', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'mindspace-dsh-transformers-'))
    directories.push(directory)
    const provider = new TransformersJsLocalEmbeddingProvider({
      modelId: 'fixture/768d',
      modelDirectory: directory,
      dimensions: 768,
      loadModule: async () => ({
        env: {},
        pipeline: async () => async () => ({ data: [1, 2], dims: [1, 2] }),
      }),
    })
    await expect(provider.embed(['dimension check'])).rejects.toThrow('expected 768, got 2')
  })
})
