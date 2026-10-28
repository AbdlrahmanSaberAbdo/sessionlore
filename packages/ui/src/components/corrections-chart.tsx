import type { CorrectionsOverTime } from "@habitlore/core";

const WIDTH = 640;
const HEIGHT = 160;
const AXIS = 20;

/** Bars of Corrections per week; colours come from the theme's CSS variables. */
export function CorrectionsChart({ periods }: { periods: CorrectionsOverTime["periods"] }) {
  const max = Math.max(1, ...periods.map((p) => p.corrections));
  const slot = WIDTH / periods.length;
  const bar = Math.max(2, slot * 0.7);
  const plot = HEIGHT - AXIS;
  return (
    <svg className="chart" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="Corrections per week">
      <line className="axis" x1={0} x2={WIDTH} y1={plot} y2={plot} />
      {periods.map((p, i) => {
        const height = (p.corrections / max) * (plot - 4);
        return (
          <rect key={p.start} className="bar" x={i * slot + (slot - bar) / 2} y={plot - height} width={bar} height={height}>
            <title>{`${p.start}: ${p.corrections} ${p.corrections === 1 ? "Correction" : "Corrections"}`}</title>
          </rect>
        );
      })}
      <text className="tick" x={0} y={HEIGHT - 4}>
        {periods[0]!.start}
      </text>
      <text className="tick" x={WIDTH} y={HEIGHT - 4} textAnchor="end">
        {periods.at(-1)!.start}
      </text>
      <text className="tick" x={0} y={12}>
        {max}
      </text>
    </svg>
  );
}
