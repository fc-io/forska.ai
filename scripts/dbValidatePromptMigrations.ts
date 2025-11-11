import {$} from 'bun'

const requireEnv = (k: string): string => {
  const v = process.env[k]
  if (!v) {
    console.error(`[dbValidate] Missing env var ${k}. Ensure .env.local is loaded.`)
    process.exit(1)
  }
  return v
}

const escapeShell = (s: string): string => s.replace(/'/g, "'\\''")

const assertLocalDbRunning = async (): Promise<void> => {
  const id = (await $.nothrow()`docker compose ps -q db`.text()).trim()
  if (!id) {
    console.error('[dbValidate] Local db container not found. Start it: docker compose up -d db')
    process.exit(1)
  }
  const running = (await $.nothrow()`docker inspect -f {{.State.Running}} ${id}`.text()).trim()
  if (running !== 'true') {
    console.error('[dbValidate] Local db is not running. Start it: docker compose up -d db')
    process.exit(1)
  }
}

const psql = async (sql: string): Promise<string> => {
  const db = requireEnv('DB_NAME')
  const user = requireEnv('DB_USER')
  const pass = requireEnv('DB_PASS')
  const cmd = `docker compose exec -T -e PGPASSWORD='${escapeShell(pass)}' db psql -U ${user} -d ${db} -v ON_ERROR_STOP=1 -At -F $'\t' <<'__SQL__'\n${sql}\n__SQL__`
  const res = await $.nothrow()`bash -lc ${cmd}`
  if (res.exitCode !== 0) {
    throw new Error('psql execution failed')
  }
  return res.text().trim()
}

const main = async (): Promise<void> => {
  await assertLocalDbRunning()
  console.log('[dbValidate] Checking remaining NULL content_hash...')
  const nullCount = await psql('SELECT COUNT(*) FROM prompts WHERE content_hash IS NULL;')
  console.log(`[dbValidate] NULL content_hash: ${nullCount}`)

  console.log('[dbValidate] Top duplicate content_hash values (rows > 1):')
  const dups = await psql(`
    SELECT content_hash, COUNT(*) AS prompt_rows
    FROM prompts
    GROUP BY content_hash
    HAVING COUNT(*) > 1
    ORDER BY prompt_rows DESC
    LIMIT 50;
  `)
  console.log(dups || '(none)')

  console.log('[dbValidate] Duplicate content_hash with reference counts:')
  const refs = await psql(`
    SELECT p.content_hash,
           COUNT(p.id) AS prompt_rows,
           SUM(j.cnt) AS judgments_refs,
           SUM(h.cnt) AS human_refs
    FROM prompts p
    LEFT JOIN LATERAL (SELECT COUNT(*) AS cnt FROM judgments j WHERE j.prompt_id = p.id) j ON TRUE
    LEFT JOIN LATERAL (SELECT COUNT(*) AS cnt FROM judgments_human h WHERE h.prompt_id = p.id) h ON TRUE
    GROUP BY p.content_hash
    HAVING COUNT(p.id) > 1
    ORDER BY prompt_rows DESC
    LIMIT 50;
  `)
  console.log(refs || '(none)')

  console.log('[dbValidate] Checking FK delete rules for prompt_id...')
  const fkRules = await psql(`
    SELECT t.relname AS table_name,
           c.conname AS constraint_name,
           CASE c.confdeltype
             WHEN 'a' THEN 'NO ACTION'
             WHEN 'r' THEN 'RESTRICT'
             WHEN 'c' THEN 'CASCADE'
             WHEN 'n' THEN 'SET NULL'
             WHEN 'd' THEN 'SET DEFAULT'
           END AS delete_rule
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace nsp_t ON nsp_t.oid = t.relnamespace
    JOIN pg_class ref ON ref.oid = c.confrelid
    JOIN pg_namespace nsp_ref ON nsp_ref.oid = ref.relnamespace
    WHERE c.contype = 'f'
      AND nsp_ref.nspname = 'public'
      AND ref.relname = 'prompts'
      AND t.relname IN ('judgments','judgments_human')
    ORDER BY t.relname, c.conname;
  `)
  console.log(fkRules || '(none)')

  console.log('[dbValidate] Listing triggers on prompts:')
  const triggers = await psql(`
    SELECT tgname
    FROM pg_trigger
    WHERE tgrelid = 'prompts'::regclass AND NOT tgisinternal
    ORDER BY tgname;
  `)
  console.log(triggers || '(none)')

  console.log('[dbValidate] Checking association tables exist:')
  const assoc = await psql(`
    SELECT 'project_prompts' AS name, to_regclass('public.project_prompts') IS NOT NULL AS exists
    UNION ALL
    SELECT 'project_articles' AS name, to_regclass('public.project_articles') IS NOT NULL AS exists;
  `)
  console.log(assoc || '(none)')

  console.log('[dbValidate] Checking project_prompts no longer has prompt_heading/type columns:')
  const ppLegacyMeta = await psql(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'project_prompts' AND column_name IN ('prompt_heading','type')
    ORDER BY column_name;
  `)
  console.log(ppLegacyMeta || '(none found)')

  console.log('[dbValidate] Checking legacy prompt columns are dropped (keep prompt_heading/type):')
  const legacyCols = await psql(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'prompts'
      AND column_name IN ('project_id','order','archived')
    ORDER BY column_name;
  `)
  console.log(legacyCols || '(none found)')

  console.log('[dbValidate] Confirm prompts has prompt_heading/type and metadata immutability trigger:')
  const promptMetaCols = await psql(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'prompts'
      AND column_name IN ('prompt_heading','type')
    ORDER BY column_name;
  `)
  console.log(promptMetaCols || '(missing prompt_heading/type)')
  const promptMetaTriggers = await psql(`
    SELECT tgname
    FROM pg_trigger
    WHERE tgrelid = 'prompts'::regclass AND NOT tgisinternal AND tgname = 'prompts_prevent_metadata_update'
    ORDER BY tgname;
  `)
  console.log(promptMetaTriggers || '(missing prompts_prevent_metadata_update trigger)')

  console.log('[dbValidate] Checking project_prompts unique and indexes:')
  const ppIdx = await psql(`
    SELECT indexname, indexdef FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'project_prompts'
    ORDER BY indexname;
  `)
  console.log(ppIdx || '(none)')

  console.log('[dbValidate] Listing triggers on project_prompts:')
  const ppTriggers = await psql(`
    SELECT tgname
    FROM pg_trigger
    WHERE to_regclass('public.project_prompts') IS NOT NULL
      AND tgrelid = to_regclass('public.project_prompts')
      AND NOT tgisinternal
    ORDER BY tgname;
  `)
  console.log(ppTriggers || '(none)')
}

void main()
