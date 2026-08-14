import type { ModelManifest } from './manifest.ts'

/** Mutable registry so an independent plugin can add compatible manifests without editing built-ins. */
export class ModelCatalog {
  private readonly manifests = new Map<string, ModelManifest>()

  constructor(manifests: readonly ModelManifest[] = []) {
    for (const manifest of manifests) this.register(manifest)
  }

  register(manifest: ModelManifest): this {
    const id = manifest.id.trim()
    if (!id) throw new Error('Model manifest id is required')
    if (this.manifests.has(id)) throw new Error(`Model manifest is already registered: ${id}`)
    if (!manifest.modelId.trim()) throw new Error(`Model manifest ${id} has no modelId`)
    if (!manifest.required.length) throw new Error(`Model manifest ${id} has no required files`)
    if (!manifest.sources.length) throw new Error(`Model manifest ${id} has no download sources`)
    this.manifests.set(id, Object.freeze({ ...manifest, id }))
    return this
  }

  list(): readonly ModelManifest[] {
    return [...this.manifests.values()]
  }

  get(id: string): ModelManifest | undefined {
    return this.manifests.get(id)
  }

  require(id: string): ModelManifest {
    const manifest = this.get(id)
    if (!manifest) throw new Error(`Unknown local embedding model: ${id}`)
    return manifest
  }
}
