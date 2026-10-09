# Astro application

See the repository [README](../README.md) for local setup, upstream synchronization,
tests, independent hosting, domain configuration, rollback and attribution.

The application consumes one ignored upstream checkout (default ../.upstream/yml)
or LOLBAS_SOURCE_DIR. Run npm run sync:upstream before development; check/build
regenerate output from the selected snapshot without fetching new content.

Canonical site URLs come from SITE_URL and SITE_BASE. Exported compatibility data
retains official upstream URLs. Generated files, .astro, dist, node_modules, and
browser reports are ignored. No backend or browser-time upstream fetch is needed.
