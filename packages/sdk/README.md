# @briq-cloud/sdk

The TypeScript client for the [briq](https://briq.cloud) REST API. Run a database, a sandbox or any
OCI image from code.

```bash
npm install @briq-cloud/sdk
```

```ts
import { Briq } from '@briq-cloud/sdk';

const briq = new Briq(process.env.BRIQ_API_KEY!);

const { briqs, outputs, costLine } = await briq.run({ recipe: 'postgres' });
console.log(outputs.DATABASE_URL, costLine);

const result = await briq.exec(briqs[0].id, ['psql', '-U', 'postgres', '-c', 'select 1']);
console.log(result.stdout);

await briq.destroy(briqs[0].id);
```

## Use

| Call | What it does |
| --- | --- |
| `run(input)` | Create a briq from a recipe or an image. |
| `up({ file })` | Bring up the services of a stack file (`briq.yaml`). |
| `exec(id, cmd)` | Run a command in a briq. `execAsync` starts one and returns at once. |
| `putFile`, `getFile` | Write or read a file in a briq. |
| `expose(id, port, mode)` | Give a port a URL, `public` or `private`. |
| `fork(id)` | Start a new briq from a copy of a briq's disk. |
| `stop`, `start`, `destroy` | Change a briq's state. |

Every method maps to one endpoint of the [REST API](https://briq.cloud/docs/api/reference). Each call that
creates briqs carries an `Idempotency-Key` and is sent again after a network error or a 502, 503
or 504, so it makes its briqs once.

## Errors

`create` takes a `size` for that sandbox: `'small'` (the default), `'medium'`, `'large'` or `'xlarge'`
(`SandboxSize`), as long as your plan offers it. Any other value throws `unsupported` before a request.

```ts
const { id } = await sandbox.create({ labels: {}, size: 'medium' });
```

A refusal throws `BriqApiError` with `status`, `code`, `message` and `requestId`.

```ts
import { BriqApiError } from '@briq-cloud/sdk';

try {
  await briq.status('bq_missing');
} catch (err) {
  if (err instanceof BriqApiError && err.status === 404) console.log(err.code, err.requestId);
  else throw err;
}
```

## Sandbox

The same entry runs commands in a sandbox on briq and reads and writes its files. Adapters for other
SDKs build on it.

```ts
import { nativeSandbox } from '@briq-cloud/sdk';

const sandbox = nativeSandbox({ apiKey: process.env.BRIQ_API_KEY! });
const { id } = await sandbox.create({ labels: {} });
await sandbox.exec(id, {
  command: 'echo hello',
  cwd: '/',
  env: {},
  timeoutMs: 10_000,
  onChunk: (chunk) => process.stdout.write(chunk.text),
});
await sandbox.destroy(id);
```

A refusal throws `BriqOperationError` with a `code` (`auth`, `not_found`, `quota`, `timeout`…).
Also exported: `fail`, `files`, `runArgv` and the types `Command`, `CommandResult`, `OutputChunk`,
`FileInfo`, `NativeFiles`, `NativeOptions`, `CreateInput`, `ExecInput`, `SandboxSize` and `OperationCode`.
`CommandResult` is what `runArgv` returns. `ExecResult` is what the client's `exec` returns.

## Options

```ts
new Briq(apiKey, {
  baseUrl: 'http://localhost:3001', // default: https://api.briq.cloud
  fetch: customFetch, // default: the global fetch
});
```

Needs Node 22.6 or later; `require('@briq-cloud/sdk')` works on Node 22.12 or later. The package
ships its own types. Its one dependency is `ws`, used by the sandbox layer.
