export type ModelSourceKind = 'modelscope' | 'huggingface'

export interface ModelSource {
  kind: ModelSourceKind
  repo: string
  revision?: string
}

export interface ModelManifest {
  /** Stable local key, also used in the installation marker. */
  id: string
  /** Human-readable catalog label; it has no effect on the stored path. */
  name?: string
  /** The identifier shown to the embedding runtime. */
  modelId: string
  /** Relative to the model-manager root. Absolute paths are deliberately rejected. */
  targetDir: string
  /** Every entry must exist before the component is considered usable. */
  required: readonly string[]
  /** Expected embedding dimension. A provider must reject incompatible output. */
  dimensions?: number
  /**
   * Optional release-pinned metadata. If a provider omits hashes for small
   * files, these entries (or the domestic listing calibrated earlier in the
   * same operation) remain the only accepted source of trust.
   */
  trustedFiles?: Readonly<Record<string, { size?: number, sha256: string }>>
  /** Map an upstream repository path to the verified local runtime path. */
  localFileMap?: Readonly<Record<string, string>>
  /** Ordered sources: domestic mirrors first, official repositories afterwards. */
  sources: readonly ModelSource[]
  /** Optional remote-file allow list, useful for repositories with training artifacts. */
  includeFile?: (path: string) => boolean
}

const TEXT2VEC_FILES = new Set([
  'config.json',
  'tokenizer_config.json',
  'onnx/tokenizer.json',
  'onnx/model.onnx',
])

/**
 * The default is deliberately configurable, but ships with the same Chinese
 * embedding model layout expected by Mindspace's local retriever.
 */
export const DEFAULT_EMBEDDING_MANIFEST: ModelManifest = {
  id: 'mindspace-text2vec-base-chinese',
  name: '中文语义向量模型',
  modelId: 'shibing624/text2vec-base-chinese',
  targetDir: 'models/shibing624/text2vec-base-chinese',
  dimensions: 768,
  required: ['config.json', 'tokenizer_config.json', 'tokenizer.json', 'onnx/model.onnx'],
  trustedFiles: {
    'config.json': { size: 856, sha256: 'fdf4d96b74a9e2dc8ae752d74bcfbbf8b3a754b3d97412477f8768ef65a7db36' },
    'tokenizer_config.json': { size: 319, sha256: '3da14b28cdfd6bcb24aef5e16a37c868bc6e8428b4180833d5e0ef9cc19931df' },
    'tokenizer.json': { size: 439124, sha256: '7dfbf1966ebf99d471c3796e9b457329d2b2182b817e144f1e904b957745c839' },
    'onnx/model.onnx': { size: 406953148, sha256: '716d380a65efde09842642540749bc0535b05f2c66737fea1106731b8b0d7ffb' },
  },
  localFileMap: { 'onnx/tokenizer.json': 'tokenizer.json' },
  sources: [
    { kind: 'modelscope', repo: 'Jerry0/text2vec-base-chinese', revision: 'master' },
    { kind: 'huggingface', repo: 'shibing624/text2vec-base-chinese', revision: 'main' },
  ],
  includeFile: path => TEXT2VEC_FILES.has(path),
}

/** Built-ins are a catalog seed, not a closed list. Consumers may register more manifests. */
export const DEFAULT_MODEL_MANIFESTS: readonly ModelManifest[] = [DEFAULT_EMBEDDING_MANIFEST]
