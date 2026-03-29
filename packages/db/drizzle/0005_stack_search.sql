-- Phase 1: Full-text search support
ALTER TABLE "stacks" ADD COLUMN "search_vector" text;--> statement-breakpoint
CREATE INDEX "idx_stacks_search" ON "stacks" USING gin (("search_vector"::tsvector));--> statement-breakpoint
CREATE OR REPLACE FUNCTION stacks_search_vector_update() RETURNS trigger AS $$
DECLARE
  proj_name text;
  org_name text;
  tag_text text;
BEGIN
  SELECT p.name, p.tenant_id INTO proj_name, org_name FROM projects p WHERE p.id = NEW.project_id;
  IF jsonb_typeof(COALESCE(NEW.tags, '{}'::jsonb)) = 'object' THEN
    SELECT string_agg(value, ' ') INTO tag_text FROM jsonb_each_text(NEW.tags);
  END IF;
  NEW.search_vector = to_tsvector('simple',
    coalesce(NEW.name, '') || ' ' ||
    coalesce(proj_name, '') || ' ' ||
    coalesce(org_name, '') || ' ' ||
    coalesce(tag_text, '')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS stacks_search_vector_trigger ON stacks;--> statement-breakpoint
CREATE TRIGGER stacks_search_vector_trigger
  BEFORE INSERT OR UPDATE ON stacks
  FOR EACH ROW EXECUTE FUNCTION stacks_search_vector_update();
