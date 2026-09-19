export default function App() {
  const hasConvexDeployment = typeof import.meta.env.VITE_CONVEX_URL === "string" && import.meta.env.VITE_CONVEX_URL.length > 0;

  return (
    <main className="shell">
      <section className="hero" aria-labelledby="page-title">
        <div className="eyebrow">OPENINGOS / PURCHASING WORKBENCH</div>
        <h1 id="page-title">Turn supplier uncertainty into a clear next move.</h1>
        <p className="lede">
          A production foundation for bounded research, evidence review, and owner-approved purchasing work.
        </p>
        <div className="status-card" role="status" aria-live="polite">
          <span className={`status-dot ${hasConvexDeployment ? "ready" : "pending"}`} aria-hidden="true" />
          <div>
            <strong>{hasConvexDeployment ? "Convex connection configured" : "Backend connection pending"}</strong>
            <p>
              {hasConvexDeployment
                ? "Authentication and reactive application services are ready for the next workflow package."
                : "Set VITE_CONVEX_URL for a hosted deployment; local UI checks remain available without provider calls."}
            </p>
          </div>
        </div>
      </section>

      <section className="principles" aria-labelledby="principles-title">
        <div>
          <div className="eyebrow">FOUNDATION STATUS</div>
          <h2 id="principles-title">Built for evidence, authority, and honest waiting.</h2>
        </div>
        <div className="principle-grid">
          <article>
            <span>01</span>
            <h3>Evidence first</h3>
            <p>Every later decision can point back to a bounded source and a reviewable state.</p>
          </article>
          <article>
            <span>02</span>
            <h3>Authority enforced</h3>
            <p>Server-side capabilities and grants remain the source of truth for external effects.</p>
          </article>
          <article>
            <span>03</span>
            <h3>Waiting is visible</h3>
            <p>Unavailable providers stay unavailable until real credentials and allowances exist.</p>
          </article>
        </div>
      </section>
    </main>
  );
}
