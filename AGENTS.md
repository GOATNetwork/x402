# Repository agent instructions

## npm releases

Before changing or publishing an npm package, read and follow
[`RELEASING.md`](RELEASING.md). It is the single source of truth for the
release procedure; the rules below are mandatory guardrails, not a replacement
for that runbook.

- Release only from the canonical `GOATNetwork/x402` repository.
- Treat tag pushes, `npm publish`, `npm unpublish`, `npm deprecate`, and
  dist-tag changes as explicit release actions; do not infer authorization
  from a review, sync, or version bump alone.
- Merge the complete release state into `main` through a PR before tagging or
  publishing.
- Validate the exact `main` merge commit from a clean clone or detached
  worktree. Stop if any required gate fails.
- Confirm npm versions and local/remote tag names are unused before creating
  annotated package tags.
- Push each intended tag explicitly. Never use `git push --tags`.
- Publish in dependency order, with `goatflow-sdk` before
  `goatflow-quickpay`.
- Verify registry metadata, tarball identity, fresh installation, imports, and
  package-specific smoke tests after publishing.
- Never weaken or bypass `minimumReleaseAge` or other supply-chain policy to
  refresh a lockfile. Defer the refresh until the package satisfies the policy.
- Never reuse a published version. A post-publish fix requires a new version.
