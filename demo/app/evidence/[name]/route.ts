import fs from "node:fs";
import path from "node:path";
import { evidenceDir } from "../../../lib/evidence";

/** Serves the recorded screenshots from docs/evidence/, so they are not copied into the app. */
export async function GET(_request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  if (!/^[a-z-]+0x[0-9a-f]{64}-(summary|frames)\.jpg$/.test(name)) return new Response("not found", { status: 404 });
  const file = path.join(evidenceDir(), name);
  if (!fs.existsSync(file)) return new Response("not found", { status: 404 });
  return new Response(fs.readFileSync(file), { headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=86400" } });
}
