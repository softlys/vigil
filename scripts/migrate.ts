/** Applies database migrations (db/migrations) and the first-start setup. `npm run db:migrate` */
import { bootstrap } from "../src/lib/bootstrap";
import { migrate, openSql } from "../src/lib/db";

async function main() {
  const sql = await openSql();
  const applied = await migrate(sql);
  const setup = await bootstrap(sql);
  console.log(`[vigil] ${sql.kind}: applied ${applied.length} migration(s)${applied.length ? ` (${applied.join(", ")})` : ""}; added ${setup.rules} rule(s) and ${setup.users} user(s).`);
  await sql.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
