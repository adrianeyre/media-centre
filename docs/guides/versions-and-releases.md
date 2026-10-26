# Versions and releases

## The Changelog and update notices

The footer's version opens the Changelog, [`CHANGELOG.md`](../../CHANGELOG.md), which [semantic-release](https://semantic-release.gitbook.io/) writes from the Conventional Commits on `main`.

As the Remote opens, the Hub reads the version in the `package.json` on GitHub's `main`, at most once an hour, and the Remote offers an update when it isn't its own, with both versions and the way to the latest release; Settings shows the same under Version. Offline, the Hub can't find out, and nothing is offered.

Set `HUB_LATEST_VERSION_URL` to read another `package.json`, or to nothing to stop the Hub looking.

## How a release is made

semantic-release runs in the CI workflow's `release` job, configured by [`.releaserc.json`](../../.releaserc.json). It:

1. picks the next version;
2. prepends it to `CHANGELOG.md`;
3. sets every `package.json` to it with [`scripts/set-version.ts`](../../scripts/set-version.ts);
4. commits that as `chore(release): <version> [skip ci]`;
5. tags it `v<version>` and makes a GitHub release.

It runs on every push to `main` that passes the gate, so each merged pull request is released (PRD §8).
