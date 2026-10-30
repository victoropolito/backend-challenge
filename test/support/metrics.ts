/** Valor de uma série no texto de exposição do Prometheus (ex.: `name{label="x"}`); undefined se ela não aparece. */
export function sampleValue(exposition: string, series: string): number | undefined {
  const line = exposition.split('\n').find((candidate) => candidate.startsWith(`${series} `));
  return line === undefined ? undefined : Number(line.slice(series.length + 1));
}
