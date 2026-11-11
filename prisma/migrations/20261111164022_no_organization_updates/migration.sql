-- Review round 2: organizations has no row-level security, so UPDATE (name, slug) let one tenant's
-- transaction rename another organization or take its slug (its members' /o/<slug> became a 404). Nothing on
-- day 1 renames an organization; day 4's settings page will bring a policy-guarded path back.
REVOKE UPDATE ("name", "slug") ON "organizations" FROM tally_app;
