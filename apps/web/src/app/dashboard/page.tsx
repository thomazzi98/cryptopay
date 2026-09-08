import { OverviewScreen } from './_overview/overview-screen';

/**
 * Nothing here is server rendered. Every figure on this screen is derived from a payment list that
 * changes while it is on screen, so a value baked into the first paint would be stale before it was
 * read; the screen polls instead and says which window its figures cover.
 */
export default function OverviewPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-text">Overview</h1>
        <p className="mt-1 text-sm text-text-muted">
          Recent activity on this key, and whether the service behind it is healthy.
        </p>
      </div>

      <OverviewScreen />
    </div>
  );
}
