import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { defineConfig } from 'tsdown'
import { transform } from 'lightningcss'
import ts from 'typescript'

const id = 'mindspace-dsh-local-rag'
const platformModules = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-runtime/client', '@deepseek-ai/dsh-client-ui-slots',
]
const cssPrefix = '\0mindspace-local-rag-css:'
const cssFiles = new Map<string, string>()
const lowerDecorators = {
  name: 'mindspace-lower-decorators',
  transform(code: string, id: string) {
    const file = id.split('?', 1)[0] ?? id
    if (!/\.[cm]?tsx?$/.test(file) || !/^\s*@[A-Za-z_$][\w$]*/m.test(code)) return
    const result = ts.transpileModule(code, {
      fileName: file,
      compilerOptions: {
        target: ts.ScriptTarget.ES2024,
        module: ts.ModuleKind.ESNext,
        ...(file.endsWith('x') ? { jsx: ts.JsxEmit.ReactJSX } : {}),
        sourceMap: true,
      },
    })
    return { code: result.outputText.replace(/\n?\/\/# sourceMappingURL=.*$/u, '\n'), map: result.sourceMapText }
  },
}

export default defineConfig([
  {
    entry: { index: 'src/index.ts', remote: 'src/generated/remote.ts', typert: 'src/generated/typert.ts' },
    outDir: 'lib', format: 'esm', platform: 'node', target: 'es2024', dts: false, clean: true, fixedExtension: false,
    plugins: [lowerDecorators],
    deps: {
      neverBundle: [
        /^@deepseek-ai\//,
        '@huggingface/transformers',
        'zod',
      ],
    },
  },
  {
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib', format: 'cjs', platform: 'browser', target: 'es2022', dts: false, sourcemap: false, clean: false,
    deps: {
      neverBundle: platformModules,
      alwaysBundle: [/^(?!react(?:\/jsx-runtime)?$|@deepseek-ai\/cordis$|@deepseek-ai\/dsh-client-runtime\/client$|@deepseek-ai\/dsh-client-ui-slots$).+/],
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    plugins: [{
      name: 'mindspace-local-rag-css',
      resolveId(source: string, importer?: string) {
        if (!source.endsWith('.module.css') || importer === undefined) return null
        const virtualId = `${cssPrefix}${source}.mjs`
        cssFiles.set(virtualId, resolve(importer, '..', source))
        return virtualId
      },
      async load(virtualId: string) {
        if (!virtualId.startsWith(cssPrefix)) return null
        const file = cssFiles.get(virtualId)
        if (file === undefined) throw new Error(`missing CSS source for ${virtualId}`)
        const result = transform({ filename: file, code: await readFile(file), cssModules: true, minify: true })
        const classes = Object.fromEntries(Object.entries(result.exports ?? {}).map(([key, value]) => [key, value.name]))
        const tag = `${id}/${basename(file)}`
        return [
          `const css=${JSON.stringify(result.code.toString())};`, `const tag=${JSON.stringify(tag)};`,
          'if(typeof document!=="undefined"&&!document.querySelector(`style[data-plugin-css="${tag}"]`)){',
          'const el=document.createElement("style");el.dataset.plugin="mindspace-dsh-local-rag";',
          'el.dataset.pluginCss=tag;el.textContent=css;document.head.appendChild(el)}',
          `export default ${JSON.stringify(classes)};`,
        ].join('\n')
      },
    }],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
