import type { Overview } from "@sessionlore/core";
import { CorrectionsChart } from "../components/corrections-chart.js";
import { Link } from "../router.js";

export function OverviewScreen({ overview }: { overview: Overview }) {
  const { counts, topWorkflows, corrections } = overview;
  return (
    <>
      <h1>Overview</h1>
      <section className="stats" aria-label="Totals">
        <Stat label="Sessions" value={counts.sessions} />
        <Stat label="Tasks" value={counts.tasks} />
        <Stat label="Workflows" value={counts.workflows} />
      </section>

      {counts.sessions === 0 ? (
        <p className="empty">
          No Sessions yet. Run <code>sessionlore scan</code>, then <code>sessionlore analyze</code>, and reload this page.
        </p>
      ) : null}

      <section className="panel">
        <h2>Corrections over time</h2>
        {corrections.periods.length === 0 ? (
          <p className="muted">
            Corrections appear here once Sessions are analyzed with <code>sessionlore analyze</code>.
          </p>
        ) : (
          <CorrectionsChart periods={corrections.periods} />
        )}
      </section>

      <section className="panel">
        <h2>Top Workflows</h2>
        {topWorkflows.length === 0 ? (
          <p className="muted">No Workflows yet: a Workflow needs Tasks repeated across several Sessions.</p>
        ) : (
          <ol className="workflows">
            {topWorkflows.map((w) => (
              <li key={w.id}>
                <Link href={`/workflows/${w.id}`} className="name">
                  {w.name}
                </Link>
                <span className="muted">
                  {w.tasks} Tasks in {w.sessions} Sessions
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <div className="value">{value.toLocaleString("en-US")}</div>
      <div className="label">{label}</div>
    </div>
  );
}
