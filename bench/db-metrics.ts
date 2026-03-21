import { SQL } from "bun";

const DB_URL =
  process.env.PROCELLA_DATABASE_URL ||
  "postgres://procella:procella@localhost:5432/procella?sslmode=disable";

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export async function getCheckpointBytes(stackId: string): Promise<number | null> {
  const sql = new SQL({ url: DB_URL });
  try {
    const rows = (await sql.unsafe(
      `SELECT length(data::text) AS checkpoint_bytes
       FROM checkpoints
       WHERE stack_id = ${quoteLiteral(stackId)} AND is_delta = false
       ORDER BY created_at DESC
       LIMIT 1`,
    )) as Array<{ checkpoint_bytes: number | null }>;

    const value = rows[0]?.checkpoint_bytes;
    return typeof value === "number" ? value : null;
  } finally {
    sql.close();
  }
}

export async function getJournalEntryCount(updateId: string): Promise<number | null> {
  const sql = new SQL({ url: DB_URL });
  try {
    const rows = (await sql.unsafe(
      `SELECT count(*)::int AS journal_entry_count
       FROM journal_entries
       WHERE update_id = ${quoteLiteral(updateId)}`,
    )) as Array<{ journal_entry_count: number | null }>;

    const value = rows[0]?.journal_entry_count;
    return typeof value === "number" ? value : null;
  } finally {
    sql.close();
  }
}

export async function getLatestUpdateId(
  org: string,
  project: string,
  stack: string,
): Promise<string | null> {
  const sql = new SQL({ url: DB_URL });
  try {
    const rows = (await sql.unsafe(
      `SELECT u.id
       FROM updates u
       JOIN stacks s ON s.id = u.stack_id
       JOIN projects p ON p.id = s.project_id
       WHERE p.tenant_id = ${quoteLiteral(org)}
         AND p.name = ${quoteLiteral(project)}
         AND s.name = ${quoteLiteral(stack)}
       ORDER BY u.created_at DESC
       LIMIT 1`,
    )) as Array<{ id: string | null }>;

    const value = rows[0]?.id;
    return typeof value === "string" ? value : null;
  } finally {
    sql.close();
  }
}

export async function getStackId(org: string, project: string, stack: string): Promise<string | null> {
  const sql = new SQL({ url: DB_URL });
  try {
    const rows = (await sql.unsafe(
      `SELECT s.id
       FROM stacks s
       JOIN projects p ON p.id = s.project_id
       WHERE p.tenant_id = ${quoteLiteral(org)}
         AND p.name = ${quoteLiteral(project)}
         AND s.name = ${quoteLiteral(stack)}
       LIMIT 1`,
    )) as Array<{ id: string | null }>;

    const value = rows[0]?.id;
    return typeof value === "string" ? value : null;
  } finally {
    sql.close();
  }
}
