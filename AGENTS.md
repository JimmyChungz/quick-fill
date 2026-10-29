# Quick Fill workspace rules

- PRODUCT.md defines product behavior. Use only synthetic credentials in tests and logs.
- This is an independent Git repository. Do not stage or edit the parent home-directory repository.
- `dist/` is the installed Chrome extension at a persistent path. It is NOT disposable cache. Never delete, move, rename, or clean it as part of a build or general cleanup.
- Build/watch output belongs in `.build/extension/`. `npm run deploy` validates the build and fixed ID, backs up the prior runtime, then replaces files with the manifest last. Never replace a failed build into the runtime.
- Preserve manifest key / ID `neilinbkkjgcnflgamepebchiapfcibm`. Do not regenerate a key or change IDs casually; browser storage is isolated by ID.
- Do not edit Chrome Preferences/Secure Preferences, security flags, developer-mode settings, enterprise policies, or extension database files to force an installation.
- Logical user records remain schema v1. Version0.4 supports an opt-in qf-vault/version1 encrypted persistence envelope; never migrate real data without the user setting their own master password in local UI. No automatic empty-store creation to hide missing/corrupt data. Recovery backups contain private browser data and must never be committed, packaged, logged, or removed as generic residue.
- Keep `../quick-fill-backups/`, old released ZIPs, historical conversations/handoff documents and final verification evidence unless specifically authorized to remove them. Cleanup only confirmed task residue.
- Chrome Web Store signing/distribution requires a separate publishing workflow. A local ZIP/CRX is not a claim of Web Store publication or immunity from Chrome safety decisions.

- Master passwords and derived key material must never enter logs, Git, local persistent storage or public artifacts. Unlock material is trusted-session-memory only with a 15-minute absolute lease; failed expiry scheduling must revoke it.
- Public source export must pass scripts/public-source.mjs checks and exclude private history/recovery/evidence. No remote publish or license choice is inferred from a local release request.

- New/changed nonempty login credentials require explicit Vault setup through the worker gate (0.6+). Legacy reads/fill/export/delete remain available; never silently choose a master password or migrate real data.
- PRODUCT/SECURITY/PRIVACY and docs/ARCHITECTURE.md describe current behavior. Dated audit/plan files are historical evidence, not instructions to reimplement completed work.

- On 2026-10-29 the user retired the DOTS ten-repeat release gate after confirming normal use. Record it as retired by owner, never as a fabricated 10/10 PASS. MIT is approved; a new public quick-fill repository is authorized, using only the allowlisted snapshot and a fresh public Git history. Never push this private history.
