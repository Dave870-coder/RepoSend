interface Env {
  ALLOWED_ORIGINS: string;
  MAX_UPLOAD_BYTES?: string;
  PROXY_SIGNING_SECRET?: string;
}

interface LfsAction {
  href: string;
  header?: Record<string, string>;
  expires_at?: string;
  expires_in?: number;
}

interface LfsObject {
  oid: string;
  size: number;
  error?: { code: number; message: string };
  actions?: {
    upload?: LfsAction;
    verify?: LfsAction;
  };
}

interface TicketPayload {
  upload: LfsAction;
  verify?: LfsAction;
  oid: string;
  size: number;
  origin: string;
  expiresAt: number;
}

const GITHUB_API = 'https://api.github.com';
const GIT_LFS_MEDIA_TYPE = 'application/vnd.git-lfs+json';
const DEFAULT_MAX_UPLOAD_BYTES = 90 * 1024 * 1024;
const MAX_GITHUB_LFS_FILE_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_LFS_BATCH_REQUEST_BYTES = 16 * 1024;
const TICKET_LIFETIME_MS = 20 * 60 * 1000;

class ProxyError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const worker: ExportedHandler<Env> = {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    if (!origin || !isAllowedOrigin(origin, env.ALLOWED_ORIGINS)) {
      return new Response('Origin not allowed', { status: 403 });
    }

    const cors = corsHeaders(origin);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        return jsonResponse({ maxUploadBytes: getMaxUploadBytes(env) }, 200, cors);
      }
      if (request.method === 'POST' && url.pathname === '/lfs/batch') {
        return await createLfsUpload(request, env, origin, cors, url.origin);
      }
      if (request.method === 'PUT' && url.pathname === '/lfs/upload') {
        return await uploadLfsObject(request, env, origin, cors);
      }
      return jsonResponse({ message: 'Route not found.' }, 404, cors);
    } catch (error) {
      if (error instanceof ProxyError) {
        return jsonResponse({ message: error.message }, error.status, cors);
      }
      return jsonResponse(
        { message: error instanceof Error ? error.message : 'Unexpected Worker error.' },
        500,
        cors,
      );
    }
  },
};

export default worker;

async function createLfsUpload(
  request: Request,
  env: Env,
  origin: string,
  cors: HeadersInit,
  workerOrigin: string,
): Promise<Response> {
  const token = readBearerToken(request);
  const input = await parseJson(request);
  if (
    typeof input.owner !== 'string'
    || !/^[\w.-]+$/.test(input.owner)
    || typeof input.repo !== 'string'
    || !/^[\w.-]+$/.test(input.repo)
    || typeof input.branch !== 'string'
    || !isValidBranch(input.branch)
    || typeof input.oid !== 'string'
    || !/^[a-f\d]{64}$/i.test(input.oid)
    || typeof input.size !== 'number'
    || !Number.isSafeInteger(input.size)
    || input.size < 0
  ) {
    throw new ProxyError('Invalid Git LFS upload request.', 400);
  }

  const maxUploadBytes = getMaxUploadBytes(env);
  if (input.size > maxUploadBytes) {
    throw new ProxyError(
      `This Worker is configured for files up to ${formatMebibytes(maxUploadBytes)} MiB. Increase its limit only if your Cloudflare plan allows it.`,
      413,
    );
  }

  const repoPath = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`;
  const repoResponse = await githubApiRequest(`${GITHUB_API}${repoPath}`, token);
  const repository = await readJson<{ has_pages?: boolean }>(repoResponse);
  if (repository.has_pages) {
    throw new ProxyError('Git LFS uploads are disabled for repositories with GitHub Pages enabled.', 400);
  }

  const userResponse = await githubApiRequest(`${GITHUB_API}/user`, token);
  const user = await readJson<{ login?: string }>(userResponse);
  if (!user.login) throw new ProxyError('GitHub did not return the authenticated account name.', 502);

  const lfsUrl = `https://github.com/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}.git/info/lfs/objects/batch`;
  const authorization = btoa(`${user.login}:${token}`);
  const lfsResponse = await retryFetch(lfsUrl, {
    method: 'POST',
    headers: {
      Accept: GIT_LFS_MEDIA_TYPE,
      Authorization: `Basic ${authorization}`,
      'Content-Type': GIT_LFS_MEDIA_TYPE,
    },
    body: JSON.stringify({
      operation: 'upload',
      transfers: ['basic'],
      ref: { name: `refs/heads/${input.branch}` },
      objects: [{ oid: input.oid, size: input.size }],
      hash_algo: 'sha256',
    }),
  });
  if (!lfsResponse.ok) {
    const detail = await readErrorMessage(lfsResponse);
    throw new ProxyError(detail || `GitHub LFS rejected the request (${lfsResponse.status}).`, lfsResponse.status);
  }

  const result = await readJson<{ objects?: LfsObject[] }>(lfsResponse);
  const lfsObject = result.objects?.find((object) => object.oid === input.oid);
  if (!lfsObject) throw new ProxyError('GitHub LFS returned no result for the requested file.', 502);
  if (lfsObject.error) {
    throw new ProxyError(lfsObject.error.message || 'GitHub LFS rejected this file.', lfsObject.error.code || 422);
  }

  if (lfsObject.actions?.upload) {
    const secret = env.PROXY_SIGNING_SECRET;
    if (!secret || secret.length < 32) {
      throw new ProxyError('Set a random PROXY_SIGNING_SECRET on this Worker before uploading LFS files.', 503);
    }
    validateAction(lfsObject.actions.upload);
    if (lfsObject.actions.verify) validateAction(lfsObject.actions.verify);
    const expiresAt = getTicketExpiry(lfsObject.actions.upload, lfsObject.actions.verify);
    if (expiresAt <= Date.now()) {
      throw new ProxyError('GitHub returned an expired LFS upload action. Retry the publish.', 502);
    }
    const ticket = await signTicket({
      upload: lfsObject.actions.upload,
      ...(lfsObject.actions.verify ? { verify: lfsObject.actions.verify } : {}),
      oid: input.oid,
      size: input.size,
      origin,
      expiresAt,
    }, secret);

    lfsObject.actions = {
      upload: {
        href: `${workerOrigin}/lfs/upload`,
        header: { 'X-RepoSend-LFS-Ticket': ticket },
      },
    };
  }

  return jsonResponse({ object: lfsObject }, 200, cors);
}

async function uploadLfsObject(
  request: Request,
  env: Env,
  origin: string,
  cors: HeadersInit,
): Promise<Response> {
  const secret = env.PROXY_SIGNING_SECRET;
  const ticket = request.headers.get('X-RepoSend-LFS-Ticket');
  if (!secret || !ticket) throw new ProxyError('Missing signed LFS upload ticket.', 401);
  const payload = await verifyTicket(ticket, secret);
  if (payload.origin !== origin) throw new ProxyError('This upload ticket belongs to a different site.', 403);
  if (payload.expiresAt <= Date.now()) throw new ProxyError('The LFS upload ticket expired. Retry the publish.', 401);

  const contentLength = request.headers.get('Content-Length');
  if (contentLength && Number(contentLength) !== payload.size) {
    throw new ProxyError('The uploaded file size did not match its LFS ticket.', 400);
  }
  if (!request.body) throw new ProxyError('The LFS upload body is empty.', 400);

  const uploadResponse = await fetch(payload.upload.href, {
    method: 'PUT',
    headers: payload.upload.header,
    body: request.body,
  });
  if (!uploadResponse.ok) {
    throw new ProxyError(`GitHub's LFS storage rejected the file (${uploadResponse.status}). Retry the publish.`, 502);
  }

  if (payload.verify) {
    const verifyHeaders = new Headers(payload.verify.header);
    verifyHeaders.set('Accept', GIT_LFS_MEDIA_TYPE);
    verifyHeaders.set('Content-Type', GIT_LFS_MEDIA_TYPE);
    const verifyResponse = await fetch(payload.verify.href, {
      method: 'POST',
      headers: verifyHeaders,
      body: JSON.stringify({ oid: payload.oid, size: payload.size }),
    });
    if (!verifyResponse.ok) {
      throw new ProxyError(`GitHub LFS could not verify the uploaded file (${verifyResponse.status}). Retry the publish.`, 502);
    }
  }

  return jsonResponse({ uploaded: true }, 200, cors);
}

async function githubApiRequest(url: string, token: string): Promise<Response> {
  const response = await retryFetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) {
    const detail = await readErrorMessage(response);
    throw new ProxyError(detail || `GitHub API request failed (${response.status}).`, response.status);
  }
  return response;
}

async function retryFetch(url: string, init: RequestInit): Promise<Response> {
  const maxAttempts = 4;
  let response: Response | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      response = await fetch(url, init);
    } catch {
      if (attempt === maxAttempts - 1) {
        throw new ProxyError('Could not reach GitHub. Check the Worker network and try again.', 502);
      }
      await delay(500 * 2 ** attempt);
      continue;
    }
    if (response.ok || ![408, 429, 500, 502, 503, 504].includes(response.status) || attempt === maxAttempts - 1) {
      return response;
    }
    await delay(500 * 2 ** attempt);
  }
  if (!response) throw new ProxyError('Could not reach GitHub. Check the Worker network and try again.', 502);
  return response;
}

function readBearerToken(request: Request): string {
  const authorization = request.headers.get('Authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match) throw new ProxyError('Send a GitHub token using Bearer authorization.', 401);
  return match[1].trim();
}

async function parseJson(request: Request): Promise<Record<string, unknown>> {
  const contentLength = request.headers.get('Content-Length');
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
      throw new ProxyError('Invalid request content length.', 400);
    }
    if (declaredLength > MAX_LFS_BATCH_REQUEST_BYTES) {
      throw new ProxyError('Request body exceeds the allowed size.', 413);
    }
  }

  if (!request.body) throw new ProxyError('Request body must be valid JSON.', 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_LFS_BATCH_REQUEST_BYTES) {
        throw new ProxyError('Request body exceeds the allowed size.', 413);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ProxyError) throw error;
    throw new ProxyError('Request body must be valid JSON.', 400);
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new ProxyError('Request body must be valid JSON.', 400);
  }
  if (!isRecord(parsed)) throw new ProxyError('Request body must be a JSON object.', 400);
  return parsed;
}

async function readJson<T>(response: Response): Promise<T> {
  try {
    return await response.json() as T;
  } catch {
    throw new ProxyError('GitHub returned an invalid response.', 502);
  }
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json() as { message?: string };
    return body.message || '';
  } catch {
    return '';
  }
}

function getMaxUploadBytes(env: Env): number {
  const configured = env.MAX_UPLOAD_BYTES;
  const value = configured === undefined ? DEFAULT_MAX_UPLOAD_BYTES : Number(configured);
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_GITHUB_LFS_FILE_BYTES) {
    throw new ProxyError('MAX_UPLOAD_BYTES must be a positive whole number no larger than 5 GiB.', 500);
  }
  return value;
}

function formatMebibytes(bytes: number): number {
  return Math.floor(bytes / (1024 * 1024));
}

function isAllowedOrigin(origin: string, allowedOrigins: string): boolean {
  return allowedOrigins.split(',').map((item) => item.trim()).includes(origin);
}

function corsHeaders(origin: string): Headers {
  return new Headers({
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Authorization, Content-Type, X-RepoSend-LFS-Ticket',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
    'Vary': 'Origin',
  });
}

function jsonResponse(body: unknown, status: number, cors: HeadersInit): Response {
  const headers = new Headers(cors);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { status, headers });
}

function isValidBranch(branch: string): boolean {
  const invalidCharacter = Array.from(branch).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 32 || code === 127 || '~^:?*[]\\'.includes(character);
  });
  return Boolean(branch)
    && !branch.startsWith('/')
    && !branch.endsWith('/')
    && !branch.includes('..')
    && !branch.includes('@{')
    && !invalidCharacter
    && !branch.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.lock'));
}

function validateAction(action: unknown): asserts action is LfsAction {
  if (!isLfsAction(action)) throw new ProxyError('GitHub returned an invalid LFS upload action.', 502);
}

function isLfsAction(action: unknown): action is LfsAction {
  if (
    !isRecord(action)
    || typeof action.href !== 'string'
    || (action.header !== undefined && (
      !isRecord(action.header)
      || Object.values(action.header).some((value) => typeof value !== 'string')
    ))
    || (action.expires_at !== undefined && (
      typeof action.expires_at !== 'string'
      || !Number.isFinite(Date.parse(action.expires_at))
    ))
    || (action.expires_in !== undefined && (
      typeof action.expires_in !== 'number'
      || !Number.isFinite(action.expires_in)
      || action.expires_in <= 0
    ))
  ) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(action.href);
  } catch {
    return false;
  }
  return url.protocol === 'https:';
}

function getTicketExpiry(upload: LfsAction, verify?: LfsAction): number {
  const candidates = [Date.now() + TICKET_LIFETIME_MS];
  for (const action of [upload, verify]) {
    if (action?.expires_at) {
      const expiresAt = Date.parse(action.expires_at);
      if (Number.isFinite(expiresAt)) candidates.push(expiresAt - 30_000);
    } else if (typeof action?.expires_in === 'number' && Number.isFinite(action.expires_in)) {
      candidates.push(Date.now() + action.expires_in * 1000 - 30_000);
    }
  }
  return Math.min(...candidates);
}

async function signTicket(payload: TicketPayload, secret: string): Promise<string> {
  const encodedPayload = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await importSigningKey(secret);
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(encodedPayload)),
  );
  return `${encodedPayload}.${toBase64Url(signature)}`;
}

async function verifyTicket(ticket: string, secret: string): Promise<TicketPayload> {
  const [encodedPayload, encodedSignature, extra] = ticket.split('.');
  if (
    ticket.length > 16_384
    || !encodedPayload
    || !encodedSignature
    || extra
    || !/^[A-Za-z0-9_-]+$/.test(encodedPayload)
    || !/^[A-Za-z0-9_-]+$/.test(encodedSignature)
  ) {
    throw new ProxyError('Invalid LFS upload ticket.', 401);
  }
  let signature: Uint8Array;
  try {
    signature = fromBase64Url(encodedSignature);
  } catch {
    throw new ProxyError('Invalid LFS upload ticket.', 401);
  }
  if (signature.byteLength !== 32) throw new ProxyError('Invalid LFS upload ticket.', 401);

  const key = await importSigningKey(secret);
  const isValid = await crypto.subtle.verify(
    'HMAC',
    key,
    toArrayBuffer(signature),
    new TextEncoder().encode(encodedPayload),
  );
  if (!isValid) throw new ProxyError('Invalid LFS upload ticket.', 401);

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromBase64Url(encodedPayload)));
  } catch {
    throw new ProxyError('Invalid LFS upload ticket.', 401);
  }

  if (!isRecord(payload)) throw new ProxyError('Invalid LFS upload ticket.', 401);
  const parsed = payload;
  if (
    typeof parsed.size !== 'number'
    || !Number.isSafeInteger(parsed.size)
    || parsed.size < 0
    || typeof parsed.oid !== 'string'
    || !/^[a-f\d]{64}$/i.test(parsed.oid)
    || typeof parsed.origin !== 'string'
    || typeof parsed.expiresAt !== 'number'
    || !Number.isSafeInteger(parsed.expiresAt)
  ) {
    throw new ProxyError('Invalid LFS upload ticket.', 401);
  }
  const upload = parsed.upload;
  const verify = parsed.verify;
  if (!isLfsAction(upload) || (verify !== undefined && !isLfsAction(verify))) {
    throw new ProxyError('Invalid LFS upload ticket.', 401);
  }
  return {
    upload,
    ...(verify === undefined ? {} : { verify }),
    oid: parsed.oid,
    size: parsed.size,
    origin: parsed.origin,
    expiresAt: parsed.expiresAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function importSigningKey(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) throw new ProxyError('The Worker signing secret must be at least 32 characters.', 503);
  return await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
