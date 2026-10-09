# Independent LOLBAS UI and upstream synchronization

## Approved outcome

Move the existing Astro UI to magicsword-io/lolbas-ui and host it independently.
The UI repository contains UI, build/sync automation, tests and attribution only.
Canonical catalog remains LOLBAS-Project/LOLBAS. No source YAML is committed.
Keep current LOLBAS appearance, search/filter/sorting/details/timeline behavior,
and compatible generated exports. Clearly credit the upstream project and identify
this as an independent interface. No MagicSword marketing in the UI.

Publication to this new site's GitHub Pages is authorized. Repository remains
private until the user separately changes visibility. A future custom domain
(lolbas.io or another user-owned domain) must be supported via configuration.
Do not modify upstream LOLBAS, its official publisher, or the existing fork PR.

## Behavior contract

| ID | Required behavior and evidence |
| --- | --- |
| UI-SYNC-001 | Every scheduled check inspects upstream GitHub events and resolves default-branch HEAD. Head comparison catches delayed/missing feed events and squash/rebase/direct pushes. Unchanged upstream/UI skips build. Scheduled checks are best-effort every five minutes, not real-time webhooks; several merges may coalesce. |
| UI-SYNC-002 | Build reads one immutable, verified upstream commit in an ignored checkout. Only YAML is consumed; no upstream scripts/workflows execute. Invalid input fails without replacing the live site. |
| UI-REL-001 | Read-only PR CI validates and tests output but cannot publish or write state. Only this repo main push/schedule/manual can publish tested artifacts to its own Pages environment. State advances only after successful deployment; failures remain retryable. |
| UI-REL-002 | Deployment records both UI and upstream revisions. Rebuilds on UI changes, supports forced/pinned manual rebuild and documents rollback. No API credentials shipped in HTML. |
| UI-SITE-001 | Existing catalog, timeline, detail/copy, sorting/filter/URL/mobile/no-JS behavior preserved. Own site origin/base configurable, canonical/source links accurate, upstream licenses and independent attribution ship. |

Assurance A3 for sync/publication path, A2 for UI/data seam. Evidence: synthetic
merge/no-op/failure/security tests, real upstream checkout/build, static/type
checks, browser interactions/screenshots, independent release/security review,
remote CI, first successful deployment and unchanged sync run.

Stop after new-repo push, verified live UI and enabled scheduled sync with exact
revision evidence. Domain registration/DNS changes and making repo public are
separate future actions. GitHub schedules may be delayed/disabled after inactivity;
document monitoring and webhook/repository_dispatch option if truly instant events
are later needed.
