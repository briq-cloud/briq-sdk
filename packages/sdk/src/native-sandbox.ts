import { Briq, type BriqRecord, type RunResult } from './index.js';
import { BriqOperationError, fail, safe, statusCode } from './native-errors.js';
import { type OutputChunk, runArgv } from './native-exec.js';
import { files } from './native-files.js';
import { runHttp, viaHttp } from './native-rest-exec.js';
export interface NativeOptions {
  apiKey: string;
  baseUrl?: string;
  stack?: string;
  fetch?: typeof fetch;
  image?: string;
  marker?: string;
  /** Default `small`. A benchmark seed exists per size, so only these two are offered. */
  size?: 'small' | 'nano';
  /**
   * Default true: `create` reads `GET /v1/quota` and runs a Python readiness exec before it returns.
   * False: `create` is the POST alone (the API refuses what it cannot do, `wait` answers once the
   * briq runs), so the first command is the first exec. Quota is still read when the creation
   * environment is not empty, because literal secrets need the API to say it honours them.
   */
  eagerChecks?: boolean;
}
export type Labels = Record<string, string>;
export interface CreateInput {
  name?: string;
  labels: Labels;
  env?: Record<string, string>;
  key?: string;
  network?: unknown;
  signal?: AbortSignal;
  ports?: number[];
  size?: unknown;
  idleTimeoutMs?: number;
  timeoutMs?: number;
  from?: unknown;
}
export interface ExecInput {
  command: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  stdin?: string;
  signal?: AbortSignal;
  onChunk(chunk: OutputChunk): void;
}
export const SUPPORTED_IMAGE = 'ghcr.io/briq-cloud/sandbox:latest';
const DEFAULT_MARKER = 'briq/opencore-provider';
const KEY = 'briq/opencore-key';
const BOOT_TIMEOUT_MS = 75000;
// Leave room for the response inside the HTTP transport's 30s deadline.
const CREATE_WAIT_MS = 25000;
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(fail('aborted', 'Creation cancelled'));
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(fail('aborted', 'Creation cancelled'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
function creationLabels(input: CreateInput, MARKER: string): Labels {
  if (!input.labels || typeof input.labels !== 'object' || Array.isArray(input.labels))
    throw fail('invalid_argument', 'Labels must be a string record');
  if (Object.hasOwn(input.labels, MARKER) || Object.hasOwn(input.labels, KEY))
    throw fail('invalid_argument', 'Briq provider label names are reserved');
  const result = {
    ...input.labels,
    [MARKER]: '1',
    ...(input.key === undefined ? {} : { [KEY]: input.key }),
  };
  const entries = Object.entries(result);
  if (
    Object.hasOwn(result, '__proto__') ||
    entries.length > 32 ||
    entries.some(([k, v]) => !k || k.length > 128 || typeof v !== 'string' || v.length > 1024) ||
    Buffer.byteLength(JSON.stringify(result)) > 16384
  )
    throw fail('invalid_argument', 'Labels exceed Briq API bounds');
  return result;
}
function creationEnvironment(env: Record<string, string> = {}) {
  const entries = Object.entries(env);
  if (
    entries.length > 100 ||
    entries.some(
      ([key, value]) =>
        !key ||
        /[=\0]/.test(key) ||
        key.length > 128 ||
        typeof value !== 'string' ||
        value.includes('\0') ||
        Buffer.byteLength(value) > 32768,
    )
  )
    throw fail('invalid_argument', 'Creation environment exceeds Briq API bounds');
  const secretPrefix = `OC_${crypto.randomUUID().replaceAll('-', '')}`;
  // OpenCore merges secrets into env before calling Provider.create. Use the
  // existing encrypted Briq secret-value input for every value, never plain env.
  return Object.fromEntries(
    entries.map(([key, value], index) => [
      key,
      { secret: `${secretPrefix}_${index}`, value, literal: true },
    ]),
  );
}
/** Maintained provider for the fixed Briq sandbox image; no arbitrary-image contract. */
export function nativeSandbox(options: NativeOptions) {
  const MARKER = options.marker ?? DEFAULT_MARKER;
  const SUPPORTED_IMAGE = options.image ?? 'ghcr.io/briq-cloud/sandbox:latest';
  const SIZE = options.size ?? 'small';
  const eager = options.eagerChecks !== false;
  if (!options.apiKey) throw fail('auth', 'A Briq API key is required');
  let base: URL;
  try {
    base = new URL(options.baseUrl ?? 'https://api.briq.cloud');
  } catch {
    throw fail('invalid_argument', 'Invalid Briq API origin');
  }
  if (
    !['https:', 'http:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== '/'
  )
    throw fail('invalid_argument', 'API URL must be an HTTP(S) origin');
  const origin = base.origin;
  const stack = options.stack ?? 'opencore';
  if (
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(stack) ||
    stack.length > 32 ||
    stack === 'briq-credential-gateway'
  )
    throw fail('invalid_argument', 'Invalid Briq stack');
  const http: typeof fetch = (url, init) =>
    (options.fetch ?? fetch)(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(30000)]),
    });
  // The same client without the 30 s deadline: a command carries its own (`runHttp`).
  const httpNoDeadline: typeof fetch = (url, init) =>
    (options.fetch ?? fetch)(url, { ...init, redirect: 'error' });
  const client = new Briq(options.apiKey, { baseUrl: origin, fetch: http });
  const managedIds = new Set<string>();
  async function destroyKnown(id: string) {
    let current: BriqRecord;
    try {
      current = (await safe(() => client.destroy(id))).briq;
    } catch (error) {
      if (error instanceof BriqOperationError && error.code === 'not_found') {
        managedIds.delete(id);
        return;
      }
      throw error;
    }
    const until = Date.now() + 60000;
    while (current.state !== 'destroyed') {
      if (Date.now() >= until)
        throw fail('outcome_unknown', 'Briq deletion could not be confirmed');
      await sleep(500);
      try {
        current = (await safe(() => client.status(id))).briq;
      } catch (error) {
        if (error instanceof BriqOperationError && error.code === 'not_found') break;
        throw error;
      }
    }
    managedIds.delete(id);
  }
  function info(row: BriqRecord): {
    id: string;
    key?: string;
    labels: Labels;
    state: 'running' | 'stopped';
    createdAt: number;
  } {
    if (row.image !== SUPPORTED_IMAGE || row.labels?.[MARKER] !== '1' || row.state === 'destroyed')
      throw fail('not_found', 'Sandbox is not managed by this provider');
    const createdAt = Date.parse(row.createdAt);
    if (!Number.isFinite(createdAt)) throw fail('provider', 'Invalid Briq creation time');
    managedIds.add(row.id);
    const labels = Object.fromEntries(
      Object.entries(row.labels).filter(([key]) => key !== MARKER && key !== KEY),
    );
    return {
      id: row.id,
      ...(row.labels[KEY] === undefined ? {} : { key: row.labels[KEY] }),
      labels,
      state: row.state === 'running' ? 'running' : 'stopped',
      createdAt,
    };
  }
  async function managed(id: string) {
    if (managedIds.has(id)) return;
    info((await safe(() => client.status(id))).briq);
  }
  /**
   * A command over the HTTP client that created the sandbox when nothing needs the stream
   * (`viaHttp`: `live: false`, no signal, 1 to 60 s), else over the WebSocket. Same result either
   * way. Every caller gets it through `live`, which defaults to the stream: `exec` keeps it, since
   * its `onChunk` is a streaming contract; the SDK's own collectors set `live: false`.
   */
  const run = async (id: string, input: Parameters<typeof runArgv>[3]) => {
    await managed(id);
    if (viaHttp(input)) return runHttp(httpNoDeadline, origin, options.apiKey, id, input);
    return runArgv(origin, options.apiKey, id, input);
  };
  const exec = (id: string, input: ExecInput) =>
    run(id, {
      cmd: ['sh', '-c', input.command],
      cwd: input.cwd,
      env: input.env,
      timeoutMs: input.timeoutMs,
      onChunk: input.onChunk,
      ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  const list = async (labels: Labels) => {
    const rows = (await safe(() => client.list({ stack }))).briqs;
    return rows
      .filter(
        (row) =>
          row.image === SUPPORTED_IMAGE &&
          row.labels?.[MARKER] === '1' &&
          row.state !== 'destroyed',
      )
      .map(info)
      .filter((row) => Object.entries(labels).every(([key, value]) => row.labels[key] === value));
  };
  return {
    name: 'briq',
    keyMode: 'best-effort',
    capabilities: new Set<never>(),
    async create(input: CreateInput) {
      for (const field of ['size', 'idleTimeoutMs', 'timeoutMs', 'from'] as const)
        if (input[field] !== undefined)
          throw fail('unsupported', `Briq cannot enforce requested ${field}`);
      if (input.network !== undefined && input.network !== 'all')
        throw fail('unsupported', 'Briq cannot enforce the requested network policy');
      if (input.signal?.aborted) throw fail('aborted', 'Creation cancelled before request');
      const labels = creationLabels(input, MARKER);
      const env = creationEnvironment(input.env);
      const hasEnv = Object.keys(env).length > 0;
      const quota = eager || hasEnv ? await safe(() => client.quota()) : undefined;
      if (quota) {
        if (!quota.team?.id)
          throw fail('unsupported', 'Briq API does not declare authenticated team identity');
        if (hasEnv && quota.features?.literalEnvSecrets !== true)
          throw fail('unsupported', 'API does not support literal encrypted environments');
        if (quota.features?.briqLabels !== true)
          throw fail('unsupported', 'Briq API does not declare persisted label support');
        if (!quota.availableSizes?.includes(SIZE))
          throw fail('unsupported', 'The configured Briq size is unavailable');
      }
      if (input.signal?.aborted) throw fail('aborted', 'Creation cancelled before request');
      const name = input.name ?? `oc-${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 32)
        throw fail('invalid_argument', 'Invalid sandbox name');
      const request = {
        stack,
        wait: true,
        waitTimeoutMs: CREATE_WAIT_MS,
        spec: {
          name,
          image: SUPPORTED_IMAGE,
          size: SIZE,
          cmd: ['sh', '-c', 'mkdir -p /workspace && exec sleep infinity'],
          env,
          ports: input.ports ?? [],
          labels,
        },
      };
      // One boot budget covers the create response, fallback reads and readiness exec.
      const until = Date.now() + BOOT_TIMEOUT_MS;
      const bootSignal = AbortSignal.any([
        ...(input.signal ? [input.signal] : []),
        AbortSignal.timeout(BOOT_TIMEOUT_MS),
      ]);
      const checkBoot = () => {
        if (input.signal?.aborted) throw fail('aborted', 'Creation cancelled');
        if (Date.now() >= until || bootSignal.aborted)
          throw fail('timeout', 'Briq boot deadline exceeded');
      };
      const bootClient = new Briq(options.apiKey, {
        baseUrl: origin,
        fetch: (url, init) => http(url, { ...init, signal: bootSignal }),
      });
      let result: RunResult;
      try {
        // One create dispatch. No SDK create retries after a potentially applied request.
        const response = await http(`${origin}/v1/briqs`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            'content-type': 'application/json',
            'idempotency-key': crypto.randomUUID(),
          },
          body: JSON.stringify(request),
          signal: bootSignal,
        });
        if (!response.ok)
          throw fail(
            response.status >= 500 || response.status === 409
              ? 'outcome_unknown'
              : statusCode(response.status),
            'Briq creation request failed',
          );
        result = (await response.json()) as RunResult;
      } catch (error) {
        if (error instanceof BriqOperationError) throw error;
        throw fail(
          'outcome_unknown',
          'Briq creation outcome unknown; inspect provider resources before retrying',
        );
      }
      const row = result.briqs?.length === 1 ? result.briqs[0] : undefined;
      if (
        !row ||
        !/^bq_[a-zA-Z0-9]+$/.test(row.id) ||
        row.name !== name ||
        (quota && row.teamId !== quota.team?.id) ||
        row.image !== SUPPORTED_IMAGE
      )
        throw fail('outcome_unknown', 'Briq returned an invalid creation receipt');
      try {
        if (Object.entries(labels).some(([k, v]) => row.labels?.[k] !== v))
          throw fail('unsupported', 'Briq did not persist requested labels');
        managedIds.add(row.id);
        let current = row;
        while (current.state !== 'running') {
          checkBoot();
          if (current.state !== 'creating' && current.state !== 'starting')
            throw fail('unavailable', 'Briq failed to start');
          // Only a still-pending blocking response needs reads. Keep them paced;
          // shortening this interval would add control-plane load to every boot.
          await sleep(Math.min(500, until - Date.now()), bootSignal);
          checkBoot();
          current = (await safe(() => bootClient.status(row.id))).briq;
        }
        checkBoot();
        if (eager) {
          const prepared = await run(row.id, {
            cmd: [
              'python3',
              '-c',
              "import os,sys; assert sys.version_info.major == 3; os.makedirs('/workspace',exist_ok=True)",
            ],
            cwd: '/',
            env: {},
            timeoutMs: Math.min(30000, until - Date.now()),
            // The boot deadline cancels it, and only the stream confirms a cancellation.
            onChunk: () => {},
            signal: bootSignal,
          });
          checkBoot();
          if (prepared.exitCode !== 0 || prepared.timedOut)
            throw fail(
              'unsupported',
              'Supported sandbox image with Python 3 and live exec streaming is required',
            );
        }
        if (input.signal?.aborted) throw fail('aborted', 'Creation cancelled');
        return info(current);
      } catch (error) {
        let failure = error;
        // Classify cancellation before cleanup, which has its own bounded budget.
        // Lost execution acknowledgements remain unknown even after cancellation.
        if (!(error instanceof BriqOperationError && error.code === 'outcome_unknown')) {
          try {
            checkBoot();
          } catch (bootError) {
            failure = bootError;
          }
        }
        try {
          await destroyKnown(row.id);
        } catch {
          throw fail(
            'outcome_unknown',
            'Creation failed and sandbox cleanup could not be confirmed',
          );
        }
        throw failure;
      }
    },
    async find(key: string) {
      return (await list({})).find((row) => row.key === key);
    },
    async connect(id: string) {
      return info((await safe(() => client.status(id))).briq);
    },
    list,
    async destroy(id: string) {
      try {
        await managed(id);
      } catch (error) {
        if (error instanceof BriqOperationError && error.code === 'not_found') return;
        throw error;
      }
      await destroyKnown(id);
    },
    exec,
    run,
    files: files(client, managed, run),
    async previewUrl(id: string, port: number) {
      await managed(id);
      const preview = await safe(() => client.expose(id, port, 'private'));
      return { url: preview.url };
    },
    native(id: string) {
      return {
        id,
        status: async () => {
          await managed(id);
          const row = (await safe(() => client.status(id))).briq;
          return {
            id: row.id,
            name: row.name,
            state: row.state,
            createdAt: row.createdAt,
            labels: info(row).labels,
          };
        },
      };
    },
  };
}
