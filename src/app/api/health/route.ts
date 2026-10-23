import { getSql } from "@/lib/db";

/** Liveness and database check. No details that would help an attacker. */
export async function GET() {
  try {
    const sql = await getSql();
    await sql.query("select 1");
    return Response.json({ status: "ok", release: process.env.APP_RELEASE ?? "dev", time: new Date().toISOString() }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ status: "error" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
