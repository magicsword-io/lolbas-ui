# LOLBAS UI engineering

Read docs/UI_CHANGE_CONTRACT.md before changing synchronization or release.
The source catalog is read-only LOLBAS-Project/LOLBAS; never commit .upstream,
generated catalog/API data, or copied catalog YAML into this repository.
Only consume a verified immutable upstream SHA. Never execute upstream example
commands, scripts or workflows. Keep GPL and upstream/logo attribution intact.

Normal UI fixes need targeted checks and browser evidence. Sync/publication
changes are A3: regression tests, real upstream seam, independent release/security
review, and release evidence. Delegate bounded read-only review when useful; the
lead owns integration and all remote writes. Workers must have disjoint ownership.

From website/: npm run sync:upstream, npm ci, npm run check, npm run test:data,
npm run build, npm test. Root: node --test scripts/*.test.mjs. Also test
SITE_BASE=/lolbas-ui and SITE_BASE=/ with a custom SITE_URL after routing changes.

Publish only tested same-run artifacts from this repo main; PRs are read-only.
Deployment state advances after successful Pages publication, never after only
a build. State/config errors fail closed. Follow README for pinned rollback/resume.
Domain/DNS and visibility changes require explicit current user authorization.
