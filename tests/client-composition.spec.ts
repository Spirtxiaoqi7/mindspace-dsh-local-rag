import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('client composition', () => {
  it('does not wait on the Remote service that its own apply function mounts', async () => {
    const source = await readFile(new URL('../src/client/index.ts', import.meta.url), 'utf8')
    const declaration = source.match(/export const inject = \[([^\]]*)\]/)?.[1] ?? ''
    expect(declaration).not.toContain('remote.localRag')
    expect(source).toContain('ctx.remote.$mount(localRagRemote)')
    expect(source).toContain("ctx.get('remote.localRag')")
    expect(source).not.toContain('ctx.remote.localRag')
  })
})
