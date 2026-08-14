/** Basic deterministic mixed Chinese/English tokens for an offline BM25+ lane. */
export function tokenize(text: string): string[] {
  const lowered = text.toLocaleLowerCase()
  const latin = lowered.match(/[a-z0-9_]+/g) ?? []
  const chineseRuns = lowered.match(/[\u4e00-\u9fff]+/g) ?? []
  const chinese = chineseRuns.flatMap((run) => {
    if (run.length === 1) return [run]
    return Array.from({ length: run.length - 1 }, (_, index) => run.slice(index, index + 2))
  })
  return [...latin, ...chinese]
}

export class Bm25Plus {
  private readonly tokens: string[][]
  private readonly termFrequencies: Map<string, number>[]
  private readonly documentFrequency = new Map<string, number>()
  private readonly averageLength: number

  constructor(
    documents: readonly string[],
    private readonly k1 = 1.5,
    private readonly b = 0.75,
    private readonly delta = 1,
  ) {
    this.tokens = documents.map(tokenize)
    this.termFrequencies = this.tokens.map((items) => {
      const frequency = new Map<string, number>()
      for (const token of items) frequency.set(token, (frequency.get(token) ?? 0) + 1)
      for (const token of frequency.keys()) this.documentFrequency.set(token, (this.documentFrequency.get(token) ?? 0) + 1)
      return frequency
    })
    this.averageLength = this.tokens.reduce((sum, items) => sum + items.length, 0) / Math.max(1, this.tokens.length)
  }

  scores(query: string): number[] {
    const queryTokens = [...new Set(tokenize(query))]
    if (!queryTokens.length || !this.tokens.length) return this.tokens.map(() => 0)
    const total = this.tokens.length
    return this.tokens.map((documentTokens, index) => {
      let score = 0
      for (const token of queryTokens) {
        const frequency = this.termFrequencies[index].get(token) ?? 0
        if (!frequency) continue
        const documentFrequency = this.documentFrequency.get(token) ?? 0
        const idf = Math.log(1 + (total - documentFrequency + 0.5) / (documentFrequency + 0.5))
        const normalization = this.k1 * (1 - this.b + (this.b * documentTokens.length) / Math.max(1, this.averageLength))
        score += idf * ((frequency * (this.k1 + 1)) / (frequency + normalization) + this.delta)
      }
      return score
    })
  }
}
