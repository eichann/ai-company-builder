/**
 * The Skill shelf (plugins.md "The Skill shelf", shared/core/skill-shelf.ts): Skills, AI
 * instruction texts and rule files a company without the shared folder publishes, every version
 * kept. Part of the one schema run by db/index.ts initDatabase. Behind the company handle
 * (ports/skill-shelf.ts).
 */
export const skillShelfSchema = `
    -- One item per place × kind × name: department_id NULL = the whole company. A department
    -- with items cannot be deleted (services/departments.ts checkDeletable; the foreign key
    -- refuses any other path).
    -- current_version NULL = taken off the shelf (its versions stay, to be put back).
    CREATE TABLE IF NOT EXISTS shelf_items (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('skill', 'instructions', 'rule')),
      department_id TEXT REFERENCES departments(id),
      name TEXT NOT NULL,
      current_version TEXT,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      changed_at TEXT NOT NULL,
      changed_by TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS shelf_items_place ON shelf_items(company_id, kind, IFNULL(department_id, ''), name);

    -- Each distinct content of an item, once (version = sha256 of shelfListing). files: JSON
    -- [{ path, base64 }]; autorun: the content has auto-run parts (shown before putting it back).
    CREATE TABLE IF NOT EXISTS shelf_versions (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL REFERENCES shelf_items(id) ON DELETE CASCADE,
      version TEXT NOT NULL,
      files TEXT NOT NULL,
      file_count INTEGER NOT NULL,
      total_bytes INTEGER NOT NULL,
      autorun INTEGER NOT NULL DEFAULT 0 CHECK (autorun IN (0, 1)),
      published_at TEXT NOT NULL,
      published_by TEXT NOT NULL,
      PRIMARY KEY (item_id, version)
    );
    CREATE INDEX IF NOT EXISTS shelf_versions_company ON shelf_versions(company_id);

    -- Who changed what is handed out, when (never updated; rows go only with their item).
    CREATE TABLE IF NOT EXISTS shelf_history (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL REFERENCES shelf_items(id) ON DELETE CASCADE,
      action TEXT NOT NULL CHECK (action IN ('publish', 'restore', 'unpublish', 'remove-version')),
      version TEXT,
      at TEXT NOT NULL,
      by_user TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS shelf_history_item ON shelf_history(company_id, item_id);

    -- An item's department, versions and history belong to the item's own company.
    CREATE TRIGGER IF NOT EXISTS shelf_items_department_company BEFORE INSERT ON shelf_items
    WHEN NEW.department_id IS NOT NULL AND NEW.company_id IS NOT (SELECT company_id FROM departments WHERE id = NEW.department_id)
    BEGIN SELECT RAISE(ABORT, 'shelf_items.company_id must be the company of its department'); END;
    CREATE TRIGGER IF NOT EXISTS shelf_versions_company BEFORE INSERT ON shelf_versions
    WHEN NEW.company_id IS NOT (SELECT company_id FROM shelf_items WHERE id = NEW.item_id)
    BEGIN SELECT RAISE(ABORT, 'shelf_versions.company_id must be the company of its item'); END;
    CREATE TRIGGER IF NOT EXISTS shelf_history_company BEFORE INSERT ON shelf_history
    WHEN NEW.company_id IS NOT (SELECT company_id FROM shelf_items WHERE id = NEW.item_id)
    BEGIN SELECT RAISE(ABORT, 'shelf_history.company_id must be the company of its item'); END;
    CREATE TRIGGER IF NOT EXISTS shelf_history_no_update BEFORE UPDATE ON shelf_history
    BEGIN SELECT RAISE(ABORT, 'shelf_history is append-only'); END;
`
