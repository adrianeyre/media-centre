# Testing

## The gate

The gate, which must pass before work lands:

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test
pnpm test:e2e     # Playwright drives the Remote, and the built Player, through a real Hub
```

CI (`.github/workflows/ci.yml`) runs the first line on every pull request and every push to `main`. The end-to-end tests need Linux's loopback addresses and the fakes, so they run locally, or in the Sandcastle image.

`pnpm format` formats everything with Prettier. ESLint leaves formatting to it, and checks the Remote's markup for accessibility with `jsx-a11y`.

The tests make their sample Media Files with ffmpeg rather than committing them, so ffmpeg must be on the `PATH` (see [Getting started](getting-started.md#what-you-need)).

## Fakes, never real Appliances

Every automated test runs against fakes of the Appliances, never a real one: a fake Samsung TV, with a fake Player and fakes of Samsung's `sdb` and `tizen` tools, a fake Midea Air Conditioner, a fake of Midea's cloud, a fake Lepro Light and a fake Hive cloud. [The fake Appliances](fakes.md) says how to run each on its own, how to point the Hub at it, what its `/_fake/` paths do, and where the end-to-end run starts it.

## Screenshots

`pnpm screenshots` takes every screenshot in `docs/images/screenshots/`, and the web app manifest's in `packages/remote/public/screenshots/`, again: desktop, tablet and phone, light and dark. It runs in Docker, because the fakes need Linux's loopback addresses, starts the same Hub and fakes as the end-to-end run, and fills them with a demo home (`scripts/screenshots/demo-home.ts`). It replaces the old screenshots only if every one was taken. The image builds on the local `sandcastle:temp` image ([Running Sandcastle](../processes/running-sandcastle.md)); set `SCREENSHOTS_BASE_IMAGE` to use another.

The icons, launch screens, link-preview image and GitHub social preview are drawn from `packages/remote/brand/` by `pnpm --filter @media-centre/remote brand`.
