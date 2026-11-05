# briq SDK

The source of [`@briq-cloud/sdk`](https://www.npmjs.com/package/@briq-cloud/sdk), the TypeScript
client for the [briq](https://briq.cloud) REST API.

## Install

```bash
npm install @briq-cloud/sdk
```

```ts
import { Briq } from '@briq-cloud/sdk';

const briq = new Briq(process.env.BRIQ_API_KEY!);
const { briqs, outputs } = await briq.run({ recipe: 'postgres' });
console.log(outputs.DATABASE_URL);
await briq.destroy(briqs[0].id);
```

More: [packages/sdk/README.md](packages/sdk/README.md) and the
[API reference](https://briq.cloud/docs/api/reference).

## Packages

| Package | What it is |
| --- | --- |
| `packages/sdk` | The client and the sandbox layer. The npm package is their bundle. |
| `packages/public` | The API's schemas and types. Its types are written into the SDK's declarations. |

## Build and test

From the root of the repo, with Node 22.6 or later and pnpm:

```bash
pnpm install
pnpm build
pnpm test
```

## Changes

Each release writes this repo again from briq's own repository: a change made here is replaced by
the next release. For a bug or an idea, write to [hello@briq.cloud](mailto:hello@briq.cloud).
