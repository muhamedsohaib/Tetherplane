# All-fetched-refs Git history provenance — 2026-10-13

> **NON-OPERATIVE RIGHTS EVIDENCE, NOT TITLE OR LICENSING CLEARANCE.** Git commit author labels alone neither prove originality nor transfer or establish copyright ownership. This review does not change any operative license or grant rights over third-party work.

## Exact scope and reproducibility

- Target: [muhamedsohaib/Tetherplane](https://github.com/muhamedsohaib/Tetherplane), all refs fetched into a fresh GitHub Actions checkout (`fetch-depth: 0`).
- [Successful provenance workflow](https://github.com/muhamedsohaib/Tetherplane/actions/runs/38454524915), at audit branch commit `39fc9b71a812ea3811b4b23f6319aee6498e5bb0`.
- Tools: [scripts/audit_all_refs.py](../../scripts/audit_all_refs.py), [tests/legal/test_all_refs.py](../../tests/legal/test_all_refs.py), [workflow](../../.github/workflows/legal-all-refs-evidence.yml).
- Build artifact `tetherplane-all-refs-legal-evidence` contains `all-ref-provenance.json` and is retained for a limited period (30-day workflow setting).
- Baseline remote main SHA `5feee084eb24bfd4831ab42840bb5f10dafc8113`. This is not the latest active development line.

## Verified counts

| Measurement | Result |
| --- | ---: |
| Fetched Git references | **63** (local audit branch, remote branches and release tag) |
| Unique commits reachable from all fetched refs | **1,089** |
| Unique commits reachable from refs but not from main | **821** |
| Author label: `Sohaib` | **814** commits |
| Author label: `Tetherplane Leno Relay` | **182** commits |
| Author label: `Tetherplane Automation` | **90** commits |
| Author label: `muhamedsohaib` | **3** commits |

These four labels account for the **1,089** distinct reachable commits. No separate, unfamiliar human author label was found in these *fetched* commit metadata records. This is stronger than the original 268-commit `main` audit but is **not** proof that no outside material, imported code, employer rights, or contributions exist.

### Specific chain-of-title question

The label **`Tetherplane Leno Relay` appears on 182 commits**. It may be an automation or relay identity controlled by the owner, but provenance requires evidence of that control, the actual contributors or processes that produced the code, and any rights in incorporated material. The user has declared that they personally own Tetherplane with no known outside claims; that remains a **self-report**, not an independent examination of source origin, employment/client contracts or legal assignments. The automation labels should not be characterized as third-party rights holders without evidence.

## What the script actually does

It reads `git for-each-ref`, `git rev-list --all`, `git log --all --format=%aN`, and the baseline `refs/remotes/origin/main`. It outputs no commit author email addresses, credential values, secret file contents or invasive machine information. Two tests in a throwaway Git repository exercise feature-branch commits and missing baseline behavior. GitHub Actions workflow completed successfully.

## Audit limitations and next steps

1. Fetched refs are not all possible histories: inaccessible/unpushed local branches, deleted refs, reflogs, and third-party forks/clones are not included.
2. Git metadata cannot substantiate copyright title, AI-generated authorship status, copied source license compliance, employment assignment, or contributor authority for alternative commercial grants.
3. Compare unique new/modified files across **all** branches to the provenance/third-party code map, not just authors or the historical `main` tree.
4. Verify the legal nature and ownership of the `Tetherplane Leno Relay` author identity without printing credentials or contacting outside parties.
5. Obtain owner-provided contracts/assignments where relevant and independent legal sign-off before adopting AGPL-3.0-only and selling alternative proprietary terms.
6. Resume local read-only git status/branch/log/remote inspection on **Leno** when accessible, then run full compliance/build gates. Do not switch execution to Vaulter, Surface or RTX.

No operative LICENSE, release tag, `main` commit or marketplace listing was changed in this phase.
