# Releasing the npm packages

This repo publishes four npm packages: `goatx402-sdk` (from `goatx402-sdk/`),
`goatx402-sdk-server` (from `goatx402-sdk-server-ts/`),
`goatx402-quickpay` (from `goatx402-quickpay/`), and `goatx402-checkout`
(from `goatx402-checkout/`). The automated publish workflow was removed for
security reasons (unrestricted trigger, unpinned actions); until a hardened
workflow replaces it, releases follow this manual runbook. Every step is
required — ad-hoc publishes drifting from git is the root cause this process
exists to prevent.

## Publish repository — GOATNetwork/x402

Releases are cut from the canonical `github.com/GOATNetwork/x402` repository
(decided 2026-07-12). `repository.url` in all four packages points there and
must stay that way. Development may happen on forks, but the release commit —
and its tags — must land on the canonical repository's default branch before
anything is published: never publish from a fork checkout, or the published
metadata would reference tags the canonical repository does not contain. When
the hardened publish workflow is restored (see follow-ups), it lives in the
canonical repository and re-enables npm `--provenance` from there.

## Runbook

The order is deliberate: the release state is committed first, validated
second, and tagged/published only after validation — a tag must never point at
a commit that was not tested, and nothing from a dirty tree may ship.

### 1. Prepare and merge the release state

For every package being released:

- set the intended version in `package.json`;
- replace its `Unreleased` CHANGELOG heading with the release date (do not
  rewrite dates for versions already published);
- confirm `repository.url` still points to `GOATNetwork/x402`; and
- merge all code, metadata, tests, and CHANGELOG changes into canonical `main`
  through the normal PR flow.

The resulting `main` merge commit is the release commit. Record its full SHA.
Never tag or publish a feature-branch commit, a pre-merge commit, or a dirty
working tree.

### 2. Create a clean checkout of the release commit

Use a fresh clone or detached worktree at the exact merge commit. For example:

```bash
git fetch origin main
git worktree add --detach /tmp/x402-release <release-commit>
cd /tmp/x402-release
test "$(git rev-parse HEAD)" = "<release-commit>"
test -z "$(git status --porcelain=v1)"
```

Do not reuse the feature-branch worktree that prepared the release.

### 3. Run package gates

These packages ship `pnpm-lock.yaml`, not `package-lock.json`. In every package
directory being released, run:

```bash
pnpm install --frozen-lockfile
npm run typecheck --if-present
npm run test:run
npm run build
npm pack --dry-run --json
```

Review the pack JSON, including package name, version, included files, shasum,
and integrity. Record the shasum for comparison after publication. The
`prepublishOnly` hook repeats tests during `npm publish`, but is only a backstop
and does not replace this gate.

Also run the package-specific smoke tests against the built output:

- QuickPay: exercise `--help`, `-h`, `help`, and any argument-boundary case
  changed by the release.
- Checkout: verify the ESM entry and evaluate the shipped browser IIFE,
  confirming it installs `window.GoatCheckout`.
- SDK and Server: import their ESM entry points and inspect non-empty exports.

### 4. Check npm identity, versions, and tags

Confirm publication will use the official registry and expected npm account:

```bash
npm config get registry
npm whoami
```

For each package/version, query npm immediately before tagging. The target
version must not appear:

```bash
npm view <package> versions --json --prefer-online
```

The intended annotated tag must be absent both locally and remotely:

```bash
git tag --list '<package>@<version>'
git ls-remote --tags origin \
  'refs/tags/<package>@<version>' \
  'refs/tags/<package>@<version>^{}'
```

Never reuse or attempt to overwrite an npm version or release tag.

### 5. Create and push annotated tags

Create one annotated tag per package on the validated release commit. Push each
tag explicitly; never use `git push --tags`.

```bash
git tag -a '<package>@<version>' \
  -m '<package> <version>' \
  '<release-commit>'
git push origin \
  'refs/tags/<package>@<version>:refs/tags/<package>@<version>'
```

Read the remote tag back with `git ls-remote --tags` and confirm its peeled
`^{}` target is the exact release commit before publishing.

### 6. Publish in dependency order

Preserve this relative order for whichever packages are in the release:

1. `goatx402-sdk`
2. `goatx402-quickpay`
3. `goatx402-sdk-server`
4. `goatx402-checkout`

QuickPay advertises the SDK 0.2.x line as an optional dependency, so the SDK
must be visible on npm before QuickPay is published. From each package's
directory in the tagged clean checkout, run:

```bash
npm publish
```

npm may require a separate browser authorization for each publish. Keep the
original command running until authorization returns. If a publish command is
interrupted or its result is uncertain, query the exact version on npm before
retrying; do not blindly rerun an irreversible publish.

After each dependency package publishes, wait until its exact version is
readable from the registry before publishing a dependent package.

### 7. Verify registry identity

Registry indexing may lag briefly. Use online queries and wait until each exact
version is visible:

```bash
npm view '<package>@<version>' \
  version dist.shasum dist.integrity dist.tarball \
  --json --prefer-online
npm view '<package>' dist-tags --json --prefer-online
```

The registry shasum must equal the `npm pack --dry-run --json` shasum, and the
expected release must be the `latest` dist-tag unless the release deliberately
uses another tag.

### 8. Run post-publish smoke tests

Install only from npm in a brand-new scratch directory. `--ignore-scripts`
ensures the smoke test exercises the files shipped in the tarball rather than
rebuilding them locally.

```bash
smoke_dir="$(mktemp -d /tmp/x402-registry-smoke.XXXXXX)"
cd "$smoke_dir"
npm install --ignore-scripts --no-audit --no-fund --prefer-online \
  '<package>@<version>'
```

Import every released package from Node ESM and require non-empty exports. Run
QuickPay's installed CLI, including:

```bash
npx --no-install goatx402-quickpay --help
```

Run Checkout's installed browser IIFE as well. When QuickPay and the SDK are
released together, use `npm ls goatx402-quickpay goatx402-sdk --depth=1` to
confirm QuickPay actually resolves the intended SDK version.

### 9. Refresh QuickPay's SDK lock resolution

After publishing an SDK version accepted by QuickPay's optional dependency
range, refresh `goatx402-quickpay/pnpm-lock.yaml` so it resolves that version.
This is a separate post-release repository change and must pass the normal PR
flow.

The active pnpm supply-chain policy may reject a package until it satisfies
`minimumReleaseAge` (currently a 24-hour window). This is expected:

- never add an exclusion or weaken the policy to make the refresh pass;
- never commit a lockfile that fails `pnpm install --frozen-lockfile`;
- leave the previous safe lock resolution in place until the window expires;
  and
- after the package becomes eligible, update only the intended resolution,
  run frozen install and the QuickPay gates again, then merge through a PR.

## Release evidence

Record the following in the release PR or GitHub Release so a publication can
be audited without reconstructing terminal history:

- full release merge commit SHA;
- annotated tag names and peeled targets;
- exact npm package names and versions;
- test counts and package-specific smoke results;
- dry-run and registry shasums (and integrity values when useful);
- final dist-tags and resolved inter-package dependency versions; and
- any deferred lockfile refresh with its eligibility time.

If a post-publish smoke test finds a defect, do not overwrite, reuse, or
silently unpublish the version. Fix it in a new version and repeat this runbook.

## Follow-ups tracked

- Restore a hardened publish workflow in the canonical repo: default-branch/
  tag-gated, protected environment, SHA-pinned actions, `--provenance`.
- CI matrix for all four packages (build + tests on push/PR).
