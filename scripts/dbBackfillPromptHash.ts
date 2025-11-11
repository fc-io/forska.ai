import {$} from 'bun'

// Avoid importing scripts/env.ts if env shape is too strict; instead, read directly
const requireEnv = (k: string): string => {
  const v = process.env[k]
  if (!v) {
    console.error(`[dbBackfillPromptHash] Missing env var ${k}. Ensure .env.local is loaded.`)
    process.exit(1)
  }
  return v
}

const log = (s: string): void => {
  console.log(`[dbBackfillPromptHash] ${s}`)
}

const fail = (s: string): never => {
  console.error(`[dbBackfillPromptHash] ${s}`)
  process.exit(1)
}

const escapeShell = (s: string): string => s.replace(/'/g, "'\\''")

const assertLocalDbRunning = async (): Promise<void> => {
  const id = (await $.nothrow()`docker compose ps -q db`.text()).trim()
  if (!id) fail('Local db container not found. Start it: docker compose up -d db')
  const running = (await $.nothrow()`docker inspect -f {{.State.Running}} ${id}`.text()).trim()
  if (running !== 'true') fail('Local db is not running. Start it: docker compose up -d db')
}

const runPsql = async (db: string, sql: string): Promise<void> => {
  const user = requireEnv('DB_USER')
  const pass = requireEnv('DB_PASS')
  const cmd = `docker compose exec -T -e PGPASSWORD='${escapeShell(pass)}' db psql -U ${user} -d ${db} -v ON_ERROR_STOP=1 -At <<'__SQL__'\n${sql}\n__SQL__`
  const res = await $.nothrow()`bash -lc ${cmd}`
  if (res.exitCode !== 0) fail('psql execution failed')
}

const sqlBackfill = `
-- Functions for normalization and hashing
CREATE OR REPLACE FUNCTION public.normalize_text_for_hash(t text) RETURNS text AS $$
BEGIN
  IF t IS NULL THEN
    RETURN '';
  END IF;
  RETURN regexp_replace(trim(replace(replace(t, E'\r\n', E'\n'), E'\r', E'\n')), E'\s+$', '');
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.compute_prompt_content_hash(orig text, trans text) RETURNS text AS $$
BEGIN
  RETURN md5(normalize_text_for_hash(orig) || '|' || normalize_text_for_hash(COALESCE(trans, '')));
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Backfill content_hash for existing rows
UPDATE "prompts"
SET "content_hash" = compute_prompt_content_hash("original_text", "transformed_text")
WHERE "content_hash" IS NULL;

-- Immutability trigger: prevent updates to prompt text
CREATE OR REPLACE FUNCTION public.prevent_prompt_text_update() RETURNS trigger AS $$
BEGIN
  IF NEW."original_text" IS DISTINCT FROM OLD."original_text" OR NEW."transformed_text" IS DISTINCT FROM OLD."transformed_text" THEN
    RAISE EXCEPTION 'Prompts are immutable: text fields cannot be updated';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "prompts_prevent_text_update" ON "prompts";
CREATE TRIGGER "prompts_prevent_text_update" BEFORE UPDATE ON "prompts"
FOR EACH ROW EXECUTE FUNCTION public.prevent_prompt_text_update();

-- Insert trigger: ensure hash is set for new rows
CREATE OR REPLACE FUNCTION public.set_prompt_hash_on_insert() RETURNS trigger AS $$
BEGIN
  IF NEW."content_hash" IS NULL THEN
    NEW."content_hash" = compute_prompt_content_hash(NEW."original_text", NEW."transformed_text");
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "prompts_set_hash_on_insert" ON "prompts";
CREATE TRIGGER "prompts_set_hash_on_insert" BEFORE INSERT ON "prompts"
FOR EACH ROW EXECUTE FUNCTION public.set_prompt_hash_on_insert();
`

const main = async (): Promise<void> => {
  // Load env from .env.local if running via package script; Bun respects --env-file in npm script not set here, so require vars
  const db = requireEnv('DB_NAME')

  await assertLocalDbRunning()
  log('Applying content_hash backfill and triggers to database: ' + db)
  await runPsql(db, sqlBackfill)
  log('Backfill complete. Validating NULLs remaining...')

  const user = requireEnv('DB_USER')
  const pass = requireEnv('DB_PASS')
  const countCmd = `docker compose exec -T -e PGPASSWORD='${escapeShell(pass)}' db psql -U ${user} -d ${db} -At -c "SELECT COUNT(*) FROM prompts WHERE content_hash IS NULL;"`
  const out = await $.nothrow()`bash -lc ${countCmd}`.text()
  log(`Remaining prompts with NULL content_hash: ${out.trim()}`)
}

void main()

