-- 0061 (P20 C2 fix): tenant-consistent FKs on contact_tag_links. Migration 0060's
-- single-column FKs let a row reference another tenant's tag/contact as long as the
-- link row's own client_id passed RLS. The composite FKs below make that impossible
-- at the storage layer (core invariant 4); the application-side join/rejection in
-- import-runner-batch.ts / import.repo.ts is defence in depth, not the guarantee.
--
-- The two new UNIQUE constraints on (client_id, id) are required because Postgres
-- needs a unique constraint matching the referenced column list for a composite FK
-- target; they are otherwise redundant with the existing surrogate-uuid PRIMARY KEY
-- for uniqueness. Both lead with client_id, so they are suite-A index-lead
-- compliant with no registry change.
--
-- Added NOT VALID then VALIDATE CONSTRAINT: additive/forward-only and safe on any
-- existing data (a stray cross-tenant row would fail loudly at VALIDATE rather than
-- being silently accepted or, worse, silently blocking the ALTER TABLE). In this
-- repo the tables are new this session and every existing row is already
-- single-tenant-consistent by construction, so VALIDATE is expected to be a no-op
-- scan, not a behaviour change.
ALTER TABLE contacts     ADD CONSTRAINT contacts_client_id_id_key     UNIQUE (client_id, id);
ALTER TABLE contact_tags ADD CONSTRAINT contact_tags_client_id_id_key UNIQUE (client_id, id);

ALTER TABLE contact_tag_links
  ADD CONSTRAINT contact_tag_links_tag_tenant_fkey
    FOREIGN KEY (client_id, tag_id) REFERENCES contact_tags (client_id, id) ON DELETE CASCADE NOT VALID,
  ADD CONSTRAINT contact_tag_links_contact_tenant_fkey
    FOREIGN KEY (client_id, contact_id) REFERENCES contacts (client_id, id) NOT VALID;

ALTER TABLE contact_tag_links VALIDATE CONSTRAINT contact_tag_links_tag_tenant_fkey;
ALTER TABLE contact_tag_links VALIDATE CONSTRAINT contact_tag_links_contact_tenant_fkey;

-- Drop the now-redundant single-column FKs from 0060 (auto-generated names,
-- confirmed against the dev DB's pg_constraint catalog, not guessed).
ALTER TABLE contact_tag_links DROP CONSTRAINT contact_tag_links_tag_id_fkey;
ALTER TABLE contact_tag_links DROP CONSTRAINT contact_tag_links_contact_id_fkey;
