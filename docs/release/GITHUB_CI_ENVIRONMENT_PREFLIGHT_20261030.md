# Environmental blockers and isolated CI preflight

Follow-up to `070066a477229f79880e60affdfc195613848093`, 2026-10-30,
Asia/Dubai. The completed release engineering was not redone. Its original
record is [GITHUB_RELEASE_READINESS_20261030.md](GITHUB_RELEASE_READINESS_20261030.md).
All 45 retained evidence files matched their original SHA256SUMS.

## Environment findings

**MSVC is not merely missing from PATH.** Visual Studio Installer's `vswhere`
3.1.7.39155 exists, but `-all -prerelease -products '*'` returns an empty list.
The `Microsoft Visual Studio\2022` and Setup `Packages\_Instances` directories
are empty. Targeted searches of the standard Visual Studio/Windows Kits locations
found no `link.exe`, `cl.exe`, `VsDevCmd.bat`, `vcvarsall.bat`, `kernel32.lib` or
`ucrt.lib`. No C++ toolchain/developer-environment variables are set.

Windows Kits 10 contains only `UnionMetadata`; its `bin`, `Lib` and `Include`
directories and registered KitsRoot10 are absent. A usable C++ compiler/linker
and Windows SDK/CRT headers/import libraries are missing. There is no installed
developer environment to activate. No toolchain was installed, no machine PATH
or registry setting was changed, and no alternate linker or security bypass was
used. Installing MSVC x64/x86 build tools and the relevant Windows SDK would need
separate owner approval; disposable hosted Windows CI is the narrower next
engineering route. See [Microsoft's Windows Rust prerequisites](https://learn.microsoft.com/en-us/windows/dev-environment/rust/setup).

**Chrome is a missing test prerequisite.** The standard 64-bit, 32-bit and
per-user Google Chrome locations and App Paths registrations are absent.
`browser/bridge/test/cdp-private-pipe.test.ts` explicitly checks the 64-bit Chrome
path before creating its lab or calling the browser implementation. The targeted
recheck fails at that assertion. This failure does not demonstrate a transport
implementation failure. The assertion was not skipped, softened or redirected.

An existing Playwright cache contains Chromium 156.0.8078.4. A separate ignored
diagnostic used the production private-pipe implementation with this cache and
a synthetic headless owned profile; it reached owned-tab observation, verified
no DevToolsActivePort, closed its tab and removed the profile. Its immediate
post-shutdown CIM check found two processes still referring to that profile,
so the diagnostic **FAILED**. A later read-only check found zero new cached
Chrome processes using temporary Tetherplane profiles. The failed result is
retained, not retried or reclassified as acceptance. It does not pass the
repository's Google Chrome test or certify a shutdown deadline. No human browser
profile, live agent or production identity was touched.

## Checks performed in this follow-up

| Check | Result |
| --- | --- |
| Original evidence integrity | 45/45 file hashes match |
| `cargo clippy --workspace --all-targets --locked -- -D warnings` | Fresh exit 101: linker `link.exe` not found |
| `cargo test --workspace --locked` | Fresh exit 101: same missing linker |
| Native release build and native E2E | Still blocked by the confirmed missing compiler/SDK prerequisite; dependent commands were not pointlessly repeated |
| Targeted Chrome private-pipe test | Fresh failure before browser launch: Windows Chrome is required |
| Supplemental cached Chromium diagnostic | FAILED immediate process-quiescence assertion; subsequent scoped process observation zero; not a Chrome substitute |
| New branch/CI isolation tests plus affected public-release policy tests | 6/6 PASS, zero skipped |
| Workflow syntax/trigger/permission analysis | All nine YAML files parsed; only `ci.yml` matches a branch push to the prepared branch |
| Diff hygiene | `git diff --check` PASS |

Previously passing Rust format, TypeScript typecheck/build/unit suites, release
archive tests and Windows installer fixtures were not repeated. The follow-up
changes only CI/deployment isolation, its regression test and this record;
kernel, native, installer, authentication and browser code are unchanged.

Fresh logs, environment receipt, publication-surface inventory and checksums are
under `target/environment-ci-preflight-20261030/`, outside the Git tree. They
are separate from the retained original evidence.

## Changes needed before considering a push

At the starting commit this branch was absent from the Control Center Vercel
deployment-denial map. Vercel's default for an unspecified branch is to deploy.
The new regression first failed on that missing rule. The exact branch
`work/github-release-readiness-20261030` is now explicitly denied in both the
repository-root and Control Center `vercel.json` files. Other branch behavior
is unchanged; there is no enabling wildcard. These are source changes only.
See [Vercel's branch deployment rules](https://vercel.com/docs/project-configuration/git-configuration).

Review also found that the CI quality job inherited repository token permissions
and persisted checkout credentials by default. The follow-up now:

- sets workflow-level `permissions: contents: read` (other token scopes none);
- pins the remaining quality actions to the same reviewed immutable action SHAs
  already used by the candidate/Store workflows;
- checks out `github.sha` explicitly in quality and uses
  `persist-credentials: false`;
- retains every existing quality/package/E2E gate and the public unsigned-release
  block, without adding a workflow trigger, artifact upload or release permission.

The regression demonstrated the missing permission boundary before the change
and passed afterward. Independent source review found no unresolved P1/P2 in
these changes. It did not certify live deployment suppression or hosted tests.

## Manual candidate workflow inspection

The existing manual workflow was inspected and left unchanged. Its repository
and branch allowlist, immutable source checkout, pinned toolchain/actions,
separate build lanes and fresh verifier runners remain intact. Only the build
jobs receive attestation/OIDC write permission; independent and fresh-host
verification jobs remain read-only. Each archive is quarantined for one day;
checksums, signed provenance subject/source/workflow/run-attempt checks and
two-build comparison precede fresh-host installation. There is no public release
or Authenticode signing step. No candidate workflow was dispatched.

The workflow is absent from the current default-branch commit
`fc8590a7e997c01878ca4d85469d6ba8eae23882`. GitHub requires a workflow to exist
on the default branch before manual dispatch. Pushing this isolated branch
cannot by itself make that workflow dispatchable; do not merge it or broaden
its triggers to bypass this requirement. See [GitHub's manual workflow rules](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).

## Publication surface

The verified remote source-parent branch still points to
`66396ac681f6f095b9ac4b827cad27e9bbea3680`; the prepared branch does not yet
exist remotely. The only unpublished history is the release engineering commit
and this follow-up commit. The rest of the stack already exists remotely.

The preflight scans all tracked/new source paths and unpublished commit contents
for common credential-token/private-key formats, private-configuration names,
executable/archive extensions and executable/archive magic. It also reviews
the new diff and workflow commands. No matching credential, private configuration
or unapproved binary was found. This is a bounded pattern/path/content review,
not a claim to detect every possible secret format. Its exact file counts and
commit list are in `publish-surface.json` and `source-file-inventory.json`.

`target/`, both evidence packets, `node_modules/`, generated `dist/` and logs
are ignored and absent from the proposed Git tree. No candidate binaries or
real credentials were produced or staged. Only `ci.yml` matches the proposed
branch push. It compiles and tests disposable binaries/containers but contains
no artifact upload, registry push, deployment, signing, attestation-write or
GitHub Release step. Other workflows' exact branch/tag/PR/manual filters do not
match this source-only push. The manual archive upload is a separate future
action requiring separate approval.

## Exact-commit handoff and remaining blocker

Source-level preparation is ready for the commit containing this record. Obtain
the full SHA from `git rev-parse HEAD` and the final handoff receipt; this follow-up
does not rewrite the original release commit. No push, tag, merge, workflow
dispatch, publication, cloud setting change or live-device operation occurred.

**A strict no-deployment push still needs live Vercel binding confirmation.**
The read-only connector found project `tetherplane-pr22-source-preview` and an
earlier Git-driven deployment from this repository, but its normalized project
and deployment responses omit current Git/root-directory/config-binding settings.
The earlier deployment log shows a failed static build, not current enforcement
of either new branch rule. There is no authenticated local Vercel CLI available
as a second read-only route. Source guards cover both the repository root and
the existing Control Center configuration root; they are not proof of live
integration enforcement. Confirm the project's actual root/config binding in
an authorized read-only dashboard/API inspection before a push under the
no-deployment restriction. Do not change cloud settings to obtain this evidence.

After that confirmation **and explicit push authorization**, the next engineering
operation is a source-only isolated-branch push, without tags or force:

```text
git push --no-follow-tags origin <PREPARED_FULL_SHA>:refs/heads/work/github-release-readiness-20261030
```

Verify the resulting CI push run has `head_sha` equal to that prepared SHA and
`event=push`; inspect Windows, Ubuntu and release-policy jobs. A PR-triggered
run can test a different merge revision, so preserve its SHA/tree separately.
Do not call the starting commit's CI the follow-up commit's verification.
Do not dispatch the manual candidate workflow, upload binaries, create a release
tag or change the public release block as part of this source-only verification.

Disposition: **source-level GO for CI preparation; conditional NO-GO for push
until live Vercel binding is confirmed and push is authorized.** Native/Chrome
host prerequisites remain missing. Trusted signing, physical SAC-On acceptance,
actual previous-version rollback and four-device acceptance remain separate
release NO-GO gates from the original report.
