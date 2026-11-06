import { loadReplayRuns } from "../lib/evidence";
import { Console } from "./Console";

export const dynamic = "force-dynamic";

export default function Page() {
  return <Console replay={loadReplayRuns()} />;
}
