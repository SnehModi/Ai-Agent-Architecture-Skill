// SCAFFOLD TEMPLATE (ai-agent-architecture skill) — adapt placeholders marked TODO to the target app.

export interface ChartSpec {
  type: 'bar' | 'line' | 'pie'
  labels: string[]
  series: { name: string; data: number[] }[]
}

const COLORS = ['#2563eb', '#d97706', '#16a34a', '#dc2626', '#7c3aed', '#0891b2']
const W = 360, H = 200, PAD = 24

export function parseChart(body: string): ChartSpec | null {
  try {
    const c = JSON.parse(body) as Partial<ChartSpec>
    const ok = (c.type === 'bar' || c.type === 'line' || c.type === 'pie') && Array.isArray(c.labels) && Array.isArray(c.series) &&
      c.series.every(s => Array.isArray(s.data) && s.data.every(Number.isFinite))
    return ok ? (c as ChartSpec) : null
  } catch {
    return null
  }
}

/** Plain SVG bar / line / pie (no chart library). Drawn from the stored spec only. */
export function Chart({ spec: { type, labels, series } }: { spec: ChartSpec }) {
  const max = Math.max(...series.flatMap(s => s.data), 0) || 1
  const n = Math.max(labels.length, 1)
  const x = (i: number) => PAD + ((W - 2 * PAD) * (i + 0.5)) / n
  const y = (v: number) => H - PAD - ((H - 2 * PAD) * Math.max(v, 0)) / max
  const first = series[0]
  const total = first?.data.reduce((a, b) => a + Math.max(b, 0), 0) || 1
  let acc = 0
  const slice = (v: number) => {
    const a0 = (acc / total) * 2 * Math.PI
    acc += Math.max(v, 0)
    const a1 = (acc / total) * 2 * Math.PI
    const p = (a: number) => `${100 + 80 * Math.sin(a)} ${100 - 80 * Math.cos(a)}`
    return `M100 100 L${p(a0)} A80 80 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${p(a1 - 1e-4)} Z`
  }
  const bw = (W - 2 * PAD) / n / (series.length + 1)
  return (
    <figure className="space-y-2">
      <svg role="img" aria-label={`${type} chart: ${series.map(s => s.name).join(', ')}`} viewBox={type === 'pie' ? '0 0 200 200' : `0 0 ${W} ${H}`} className="w-full">
        {type === 'pie' && first?.data.map((v, i) => <path key={i} d={slice(v)} fill={COLORS[i % COLORS.length]}><title>{labels[i]}: {v}</title></path>)}
        {type !== 'pie' && <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="currentColor" opacity={0.3} />}
        {type === 'bar' && series.map((s, si) => s.data.map((v, i) => (
          <rect key={`${si}-${i}`} x={x(i) - (bw * series.length) / 2 + si * bw} y={y(v)} width={bw} height={H - PAD - y(v)} fill={COLORS[si % COLORS.length]}><title>{labels[i]}: {v}</title></rect>
        )))}
        {type === 'line' && series.map((s, si) => <polyline key={si} fill="none" stroke={COLORS[si % COLORS.length]} strokeWidth={2} points={s.data.map((v, i) => `${x(i)},${y(v)}`).join(' ')} />)}
        {type !== 'pie' && labels.map((l, i) => <text key={i} x={x(i)} y={H - 8} textAnchor="middle" fontSize={9} fill="currentColor">{l}</text>)}
      </svg>
      <figcaption className="flex flex-wrap gap-3 text-xs">
        {(type === 'pie' ? labels : series.map(s => s.name)).map((l, i) => <span key={i} className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-sm" style={{ background: COLORS[i % COLORS.length] }} />{l}</span>)}
      </figcaption>
    </figure>
  )
}
