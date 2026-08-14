import { existsSync } from 'node:fs'
import path from 'node:path'

import type { EmbeddingProvider } from '../contracts.ts'
import { ModelNotReadyError } from './errors.ts'

export interface TransformersPipelineOutput {
  data: ArrayLike<number>
  dims?: readonly number[]
}

export interface TransformersFeaturePipeline {
  (texts: readonly string[], options: Record<string, unknown>): Promise<TransformersPipelineOutput>
}

export interface TransformersModule {
  env: { allowLocalModels?: boolean, allowRemoteModels?: boolean, localModelPath?: string }
  pipeline: (task: 'feature-extraction', model: string, options: Record<string, unknown>) => Promise<TransformersFeaturePipeline>
}

export interface TransformersJsLocalEmbeddingProviderOptions {
  modelId: string
  modelDirectory: string
  dimensions?: number
  loadModule?: () => Promise<TransformersModule>
}

/**
 * A local-only Transformers.js adapter. Dynamic import keeps transformers out
 * of the normal host boot path and avoids any model request until explicitly used.
 */
export class TransformersJsLocalEmbeddingProvider implements EmbeddingProvider {
  private readonly absoluteModelDirectory: string
  private readonly loadModule: () => Promise<TransformersModule>
  private pipeline?: TransformersFeaturePipeline
  private loadTask?: Promise<TransformersFeaturePipeline>
  private vectorDimensions: number

  readonly modelId: string

  constructor(options: TransformersJsLocalEmbeddingProviderOptions) {
    this.modelId = options.modelId
    this.absoluteModelDirectory = path.resolve(options.modelDirectory)
    this.vectorDimensions = options.dimensions || 0
    this.loadModule = options.loadModule || (async () => import('@huggingface/transformers') as unknown as TransformersModule)
  }

  get dimensions(): number {
    return this.vectorDimensions
  }

  async ready(): Promise<boolean> {
    if (!existsSync(this.absoluteModelDirectory)) return false
    try {
      await this.getPipeline()
      return true
    } catch {
      return false
    }
  }

  async embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    if (signal?.aborted) throw new DOMException('Embedding request cancelled', 'AbortError')
    if (!texts.length) return []
    if (!existsSync(this.absoluteModelDirectory)) throw new ModelNotReadyError(this.modelId, 'local model directory is missing')
    const output = await (await this.getPipeline())(texts, {
      pooling: 'mean',
      normalize: false,
      local_files_only: true,
    })
    if (signal?.aborted) throw new DOMException('Embedding request cancelled', 'AbortError')
    const dimensions = Number(output.dims?.at(-1) || this.vectorDimensions)
    if (!Number.isSafeInteger(dimensions) || dimensions <= 0 || output.data.length !== texts.length * dimensions) {
      throw new Error(`Local embedding output has invalid dimensions for ${this.modelId}`)
    }
    if (this.vectorDimensions && this.vectorDimensions !== dimensions) {
      throw new Error(`Local embedding output dimension mismatch for ${this.modelId}: expected ${this.vectorDimensions}, got ${dimensions}`)
    }
    this.vectorDimensions = dimensions
    const vectors: number[][] = []
    for (let index = 0; index < texts.length; index += 1) {
      const vector = Array.from({ length: dimensions }, (_, offset) => Number(output.data[index * dimensions + offset]))
      const length = Math.hypot(...vector)
      if (!Number.isFinite(length) || length === 0) throw new Error(`Local embedding output is zero-length for ${this.modelId}`)
      vectors.push(vector.map(value => value / length))
    }
    return vectors
  }

  private async getPipeline(): Promise<TransformersFeaturePipeline> {
    if (this.pipeline) return this.pipeline
    this.loadTask ||= (async () => {
      const transformers = await this.loadModule()
      // These module-wide flags are intentionally strict: transformers may read
      // only the configured directory and must never fall back to a network fetch.
      transformers.env.allowLocalModels = true
      transformers.env.allowRemoteModels = false
      const localModelRoot = path.dirname(this.absoluteModelDirectory)
      transformers.env.localModelPath = localModelRoot
      this.pipeline = await transformers.pipeline('feature-extraction', path.basename(this.absoluteModelDirectory), {
        local_files_only: true,
      })
      return this.pipeline
    })()
    return this.loadTask
  }
}
