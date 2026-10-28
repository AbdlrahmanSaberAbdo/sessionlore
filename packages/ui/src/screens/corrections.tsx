import { Link } from "../router.js";

/**
 * The Corrections screen: Correction Clusters, where Rules come from. Until it
 * has its own API, it says where to see them today.
 */
export function CorrectionsScreen() {
  return (
    <>
      <header className="page-head">
        <h1>Corrections</h1>
        <p className="lede">
          The things you keep telling your agents to do differently. When one repeats often enough, sessionlore suggests a
          Rule for it.
        </p>
      </header>
      <p className="empty">
        This screen is still being built. For now, <code>sessionlore corrections</code> lists your Correction Clusters in
        the terminal, and their Rules wait on <Link href="/">Home</Link>.
      </p>
    </>
  );
}
