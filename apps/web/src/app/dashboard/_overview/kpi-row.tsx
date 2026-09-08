import { Card, CardBody, Skeleton } from '@/components/ui/surfaces';

import type { ChangeDirection, Kpi, MetricChange } from './metrics';

/**
 * A change is written out, not drawn. An arrow alone says a figure moved and nothing about how far,
 * and a red or green arrow says nothing at all to a colour-blind reader, so the direction and the
 * magnitude are both in the sentence and the glyph is there to speed up the scan.
 */

const DIRECTION_GLYPHS: Readonly<Record<ChangeDirection, string>> = Object.freeze({
  up: '↑',
  down: '↓',
  flat: '→',
  unknown: '·',
});

function changeSentence(change: MetricChange): string {
  if (change.direction === 'unknown') {
    return 'No comparable previous 7 days in this window';
  }
  if (change.direction === 'flat') {
    return 'Unchanged from the previous 7 days';
  }
  const word = change.direction === 'up' ? 'Up' : 'Down';
  return `${word} ${change.magnitude} from the previous 7 days`;
}

function KpiTile({ kpi }: { kpi: Kpi }) {
  return (
    <Card>
      <CardBody className="flex h-full flex-col gap-3">
        <p className="text-xs font-medium tracking-wide text-text-subtle uppercase">{kpi.label}</p>

        <p className="tabular flex items-baseline gap-1.5 text-3xl leading-none font-semibold text-text">
          {kpi.value}
          {kpi.unit !== null && (
            <span className="text-sm font-medium text-text-subtle">{kpi.unit}</span>
          )}
        </p>

        <p className="text-xs text-text-muted">
          <span aria-hidden="true" className="tabular mr-1.5 text-text-subtle">
            {DIRECTION_GLYPHS[kpi.change.direction]}
          </span>
          {changeSentence(kpi.change)}
        </p>

        <p className="mt-auto border-t border-border pt-3 text-xs text-text-subtle">
          {kpi.context}
        </p>
      </CardBody>
    </Card>
  );
}

export function KpiRow({ kpis }: { kpis: readonly Kpi[] }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {kpis.map((kpi) => (
        <KpiTile key={kpi.key} kpi={kpi} />
      ))}
    </div>
  );
}

export function KpiRowSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: 4 }, (unused, index) => (
        <Card key={index}>
          <CardBody className="space-y-3">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-8 w-24" />
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-3 w-32" />
          </CardBody>
        </Card>
      ))}
    </div>
  );
}
