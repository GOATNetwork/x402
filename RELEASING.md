# Releasing the npm packages

This repo release-manages exactly four npm packages:

| npm package | Directory | Required entry artifacts |
| --- | --- | --- |
| `goatflow-sdk` | `goatx402-sdk/` | `dist/index.js`, `dist/index.d.ts` |
| `goatflow-sdk-server` | `goatx402-sdk-server-ts/` | `dist/index.js`, `dist/index.d.ts` |
| `goatflow-quickpay` | `goatx402-quickpay/` | `dist/index.js`, `dist/index.d.ts`, `dist/cli.js` |
| `goatflow-checkout` | `goatx402-checkout/` | `dist/index.js`, `dist/index.d.ts`, `dist/checkout.global.js` |

The private demo, Foundry project, Go modules, and
`goatx402-mpp-middleware-ts/` are outside this npm runbook. The presence of a
`package.json`, package name, or `prepublishOnly` script is not authorization to
publish a new package. Adding another release-managed package requires an
explicit process change, license/repository metadata review, release gates, and
approval before its first publication.

The automated publish workflow was removed for security reasons (unrestricted
trigger, unpinned actions); until a hardened workflow replaces it, releases
follow this manual runbook. Every step is required — ad-hoc publishes drifting
from git is the root cause this process exists to prevent.

## GOAT Flow package identities

The current released identities are `goatflow-sdk@0.2.1`,
`goatflow-sdk-server@0.3.0`, `goatflow-quickpay@0.3.0`, and
`goatflow-checkout@0.1.0`. Repository directory names remain `goatx402-*` and
must not be mistaken for npm package names.

Deprecating or otherwise modifying an older `goatx402-*` npm package remains a
separate, explicit release action. Do not infer authorization from a GOAT Flow
release or from documentation changes.

## Current Blockers And Known Issues

Do not tag or publish while any release blocker remains:

- **Current blocker:** all four package-local `pnpm-workspace.yaml` files omit
  `packages`. pnpm `9.15.9` rejects the required install and gate commands with
  `packages field missing or empty`. Repair and merge the workspace files
  through a normal PR, then rerun every package gate.
- **Current blocker:** the repository does not pin pnpm with a root or
  package-level `packageManager` field, Corepack contract, or equivalent
  machine-enforced version. Record and enforce the reviewed pnpm version before
  treating the workspace gate as reproducible.
- **Current blocker:** a generated declaration that ships in the Checkout npm
  tarball still contains an obsolete example origin:
  `goatx402-checkout/dist/types.d.ts` mentions `pay.goat.network`. Correct the
  source comment, rebuild `dist`, and verify the tarball contains only the
  active origins from `docs/README.md`.
- **Coordinated security blocker:** the current merchant HMAC format joins
  unescaped `key=value` pairs with `&`. It is not injective for arbitrary
  scalar values containing `&` or `=`. A complete correction requires one
  versioned canonicalization contract deployed together in Core and both
  server SDKs. Do not publish a server SDK that claims unrestricted scalar
  signing until that coordinated migration is implemented and tested.
- **Per-release blocker:** the candidate must be the exact tip of canonical
  `GOATNetwork/x402` `main`, validated from a clean checkout whose `origin`
  points to that repository.
- **Per-release blocker:** build one actual `.tgz` per package from that clean
  commit, record its identity, and publish that exact file. A dry run or a
  later rebuild is not the release artifact.

Separately, the Foundry project is outside this npm runbook and currently
installs `forge-std` without a pinned revision. That blocks reproducible
contract build or deployment sign-off; see
[`goatx402-contract/README.md`](goatx402-contract/README.md#prerequisites). It
does not add the contract project to the npm release scope.

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
- add a topmost `<version> - YYYY-MM-DD` entry to its `CHANGELOG.md`; if an
  `Unreleased` section exists, rename that section, otherwise create the
  version heading above the existing history;
- do not rewrite, reorder, or otherwise clean up historical release entries;
- confirm `repository.url` still points to `GOATNetwork/x402`; and
- merge all code, metadata, tests, and CHANGELOG changes into canonical `main`
  through the normal PR flow.

The resulting `main` merge commit is the release commit. Record its full SHA.
Never tag or publish a feature-branch commit, a pre-merge commit, or a dirty
working tree.

### 2. Create a clean checkout of the release commit

Use a fresh clone or detached worktree at the exact merge commit. For example:

```bash
canonical_url="$(git remote get-url origin)"
case "$canonical_url" in
  https://github.com/GOATNetwork/x402.git|git@github.com:GOATNetwork/x402.git) ;;
  *) echo "origin is not canonical: $canonical_url" >&2; exit 1 ;;
esac

git fetch origin main
test "$(git rev-parse origin/main)" = "<release-commit>"
git worktree add --detach /tmp/x402-release "<release-commit>"
cd /tmp/x402-release
test "$(git rev-parse HEAD)" = "<release-commit>"
test -z "$(git status --porcelain=v1)"
```

Do not reuse the feature-branch worktree that prepared the release. If
canonical `main` moves before tagging, stop and decide through a new PR/release
review whether the candidate must be rebuilt from the newer tip.

### 3. Run package gates

These packages ship `pnpm-lock.yaml`, not `package-lock.json`. In every package
directory being released, run:

```bash
pnpm install --frozen-lockfile
npm run typecheck --if-present
npm run test:run
npm run build
mkdir -p /tmp/x402-release-tarballs
npm pack --json --pack-destination /tmp/x402-release-tarballs
```

The package-local `pnpm-workspace.yaml` must be accepted by the pinned/approved
pnpm version before any gate can count. If pnpm reports
`packages field missing or empty`, stop the release and repair the workspace
configuration through a normal PR. Do **not** use `--ignore-workspace` as a
release workaround: it bypasses the workspace file that carries pnpm
supply-chain/build policy.

Review the pack JSON, including package name, version, filename, included
files, shasum, and integrity. Record those values plus an independent checksum
of the resulting `.tgz`, for example:

```bash
shasum -a 256 "/tmp/x402-release-tarballs/<filename>"
```

Run the tests explicitly as shown above; do not rely on lifecycle hooks as a
substitute. If source, metadata, dependencies, or the release commit changes,
discard the tarball and restart validation.

The `goatx402-quickpay/` and `goatx402-checkout/` directories currently define an explicit
`typecheck` script. SDK and Server do not, so `--if-present` intentionally skips
that command for those two packages; their `build` commands still run `tsc`
against the shipping build configuration.

Also run the package-specific smoke tests against the built output:

- SDK: import `dist/index.js` from Node ESM and require non-empty exports.
- Server: import `dist/index.js` from Node ESM and require non-empty exports.
- QuickPay: import `dist/index.js`; exercise `dist/cli.js --help`, `-h`, `help`,
  and any argument-boundary case changed by the release.
- Checkout: import `dist/index.js` and evaluate `dist/checkout.global.js` in a
  browser-like global, confirming it installs `window.GoatCheckout`.

Do not treat a successful TypeScript compile as proof that the package tarball
contains these files. The actual `npm pack --json` file list and `.tgz` are the
authoritative pre-publish artifacts.

### 3a. Validate candidate dependency combinations

When `goatflow-sdk` and `goatflow-quickpay` are released together, test their
exact candidate tarballs together before creating or pushing any tag. A frozen
QuickPay lockfile only proves the previous SDK resolution; it does not prove
the version that QuickPay's `^0.2.0` range will select after publication.

```bash
sdk_tgz="/tmp/x402-release-tarballs/<goatflow-sdk-filename>"
quickpay_tgz="/tmp/x402-release-tarballs/<goatflow-quickpay-filename>"
combo_dir="$(mktemp -d /tmp/x402-candidate-combo.XXXXXX)"
cd "$combo_dir"
npm init -y >/dev/null
npm install --ignore-scripts --no-audit --no-fund \
  "$sdk_tgz" "$quickpay_tgz"
npm ls goatflow-quickpay goatflow-sdk --depth=1

node --input-type=module <<'NODE'
const sdk = await import('goatflow-sdk')
const quickpay = await import('goatflow-quickpay')
const backend = await import(
  './node_modules/goatflow-quickpay/dist/backend-mpp-sdk.js'
)
const resolvedSdk = await backend.loadMppSdk()

if (typeof sdk.MPPClient !== 'function') {
  throw new Error('candidate goatflow-sdk does not export MPPClient')
}
if (typeof quickpay.SdkMppBackend !== 'function') {
  throw new Error('candidate goatflow-quickpay does not export SdkMppBackend')
}
if (resolvedSdk.MPPClient !== sdk.MPPClient) {
  throw new Error('QuickPay did not resolve the installed candidate SDK')
}
NODE
```

Record `npm ls` and the smoke-test result with the tarball checksums. Any
resolution to a registry copy, workspace link, or different SDK version fails
the pre-publish gate. A post-publish smoke test remains mandatory, but it is
evidence after an irreversible action and cannot replace this gate.

### 4. Check npm identity, versions, and tags

Confirm publication will use the official registry and expected npm account:

```bash
npm config get registry
npm whoami
```

For each package/version, query npm immediately before tagging. The target
version must not appear:

```bash
npm view '<package>' versions --json --prefer-online
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

Preserve this order for whichever packages are in the release:

1. `goatflow-sdk`
2. `goatflow-quickpay`
3. `goatflow-sdk-server`
4. `goatflow-checkout`

QuickPay currently advertises `goatflow-sdk` through `^0.2.0` as an optional
dependency, so a newly released SDK in that
range must be visible on npm before QuickPay is published. Checkout and Server
do not currently depend on the other release-managed packages, but retaining
one deterministic order makes the evidence easier to audit.

Publish the already validated tarball for each package:

```bash
npm publish "/tmp/x402-release-tarballs/<filename>"
```

npm must receive the exact `.tgz`; do not run bare `npm publish`, which repacks
the package directory and creates a second, unverified artifact.

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

The registry shasum and integrity must equal the values from the actual
pre-publish pack. Download the registry artifact to a separate directory and
compare bytes with the release tarball:

```bash
mkdir -p /tmp/x402-registry-tarballs
npm pack '<package>@<version>' \
  --json --pack-destination /tmp/x402-registry-tarballs
cmp "/tmp/x402-release-tarballs/<filename>" \
  "/tmp/x402-registry-tarballs/<filename>"
```

The expected release must be the `latest` dist-tag unless the release
deliberately uses another tag. A checksum, integrity, or byte comparison
mismatch is a failed release; do not republish the same version.

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

Import every released package from Node ESM and require non-empty exports. For
Checkout, also evaluate the installed `dist/checkout.global.js` and confirm
`window.GoatCheckout` exists. Run QuickPay's installed CLI, including:

```bash
npx --no-install goatflow-quickpay --help
```

Run Checkout's installed browser IIFE as well. When QuickPay and the SDK are
released together, use `npm ls goatflow-quickpay goatflow-sdk --depth=1` to
confirm QuickPay actually resolves the intended SDK version.

Inspect the installed package contents as well as the imports. A local workspace
link, adjacent build output, or npm cache entry must not be allowed to satisfy
the smoke test accidentally.

### 9. Refresh QuickPay's SDK lock resolution

After publishing an SDK version accepted by QuickPay's optional dependency
range, refresh `goatx402-quickpay/pnpm-lock.yaml` so it resolves that version.
This is a separate post-release repository change and must pass the normal PR
flow.

A repository-external or user-level pnpm supply-chain policy may reject a newly
published package until it satisfies `minimumReleaseAge`. Treat that rejection
as an expected safety gate:

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
- release tarball filenames, pack JSON, SHA-256 checksums, registry shasums and
  integrity values, and registry byte-comparison results;
- final dist-tags and resolved inter-package dependency versions; and
- any deferred lockfile refresh with its eligibility time.

If a post-publish smoke test finds a defect, do not overwrite, reuse, or
silently unpublish the version. Fix it in a new version and repeat this runbook.

## Follow-ups tracked

- Restore a hardened publish workflow in the canonical repo: default-branch/
  tag-gated, protected environment, SHA-pinned actions, `--provenance`.
- CI matrix for all four packages (build + tests on push/PR).
