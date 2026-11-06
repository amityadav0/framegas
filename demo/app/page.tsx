import { Demo } from "./Demo";
import { loadAdmissionReports, loadComparisonRuns } from "../lib/evidence";

export const dynamic = "force-dynamic";

export default function Page() {
  return <Demo recorded={loadComparisonRuns()} reports={loadAdmissionReports()} />;
}
