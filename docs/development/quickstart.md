# Development Quick Start

## Prerequisites

- [Node.js](https://nodejs.org/en)
- [pnpm](https://pnpm.io/)
- A container runtime: [Docker](https://www.docker.com/), [Podman](https://podman.io/), etc.

If you use [Nix](https://nixos.org/) with flakes enabled, `nix develop` provides Node, pnpm
and `dbmate` at the versions this project builds with, plus `psql`, `valkey-cli` and `jq`.
It does not start Postgres or Redis for you — use the container runtime for those, as
described below.

## Install & Run

First, install dependencies:

```shell
pnpm install
```

Copy and source the development environment variables (but hopefully not forever, see [#34](https://github.com/tjhorner/transit-tracker-api/issues/34)):

```shell
cp .env.development .env && source .env
```

Then run in development mode, which watches for changes and automatically restarts:

```shell
pnpm start:dev
```

If you are working with the GTFS database, also see [details on setting up the development database](gtfs-database.md#development-database).

## Building with Nix

The flake exposes the server as a package, so you can build and run it without a Node
toolchain on your machine:

```shell
nix build .#transit-tracker-api
./result/bin/transit-tracker-api           # the server
./result/bin/transit-tracker-api-cli sync  # the CLI
```

There is also an overlay (`overlays.default`) if you would rather compose it into your own
package set.

Build inputs are overridable, so you can move Node or pnpm without vendoring the
derivation:

```nix
transit-tracker-api.override { nodejs = pkgs.nodejs_22; }
```

If you change `pnpm-lock.yaml`, the pinned dependency hash in `nix/package.nix` must be
regenerated: set `pnpmDepsHash` to `lib.fakeHash`, build once, and record the hash Nix
reports. One hash covers every platform.

## Formatting

This project uses Prettier for formatting. Run this command to automatically format your changes before submitting:

```shell
pnpm format
```

## Testing

There are two test suites: unit tests and end-to-end tests.

### Unit Tests

Exactly as they sound — they run quickly and are as isolated as possible. For mocking dependencies, you can use `vitest-mock-extended` to create a mock for a specified service and either pass it directly (recommended when possible), or use [the NestJS testing module](https://docs.nestjs.com/fundamentals/testing).

Run unit tests:

```shell
pnpm test
```

### E2E Tests

These tests are primarily meant to test the GTFS module due to the complexity involved and the number of things that can subtly go wrong. It spins up real Postgres and Redis instances using [Testcontainers](https://testcontainers.com/) and imports a set of test GTFS feeds.

Run E2E tests:

```shell
pnpm test:e2e
```
