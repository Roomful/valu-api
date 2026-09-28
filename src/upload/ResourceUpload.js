// ===========================================================================
// Resource upload — the one function that is not a single RPC.
//
// `CMS.resource-upload` and `ApplicationStorage.resource-upload` take FILES,
// and the app serves them through UploadManager (a browser XHR pipeline),
// which is why they looked un-portable. They are not: the pipeline is four
// steps and three of them are socket RPCs. The server already ports it
// (valu-guru-server src/valu-tools/cms-upload.ts), and this is the same four
// steps written once, for both adapters.
//
//   1. resource:create           register the resource under `belonging`
//   2. resource:getUploadLink    a direct-to-bucket, resumable upload URL
//   3. PUT the bytes             one request, Content-Range spanning the file
//   4. resource:completeUploadLink   the CMS marks the resource ready
//
// `fetch` is the only non-socket dependency, and both runtimes have it; it is
// injectable so the conformance suite never opens a connection.
//
// A file is anything that can name itself and produce bytes: a browser `File`
// or `Blob` (via arrayBuffer()), or a plain `{name, contentType, bytes}` —
// which is what a headless caller has.
// ===========================================================================
import { isAckError, ackErrorMessage } from '../socket/ValuSocket.js';

/** Refused before any RPC — the same cap the server applies. */
export const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

/** RPC budget per step. Deliberately below the 30s call timeout. */
const STEP_TIMEOUT_MS = 20_000;
/** A bucket PUT is bytes over the wire, not an RPC — it gets its own budget. */
const PUT_TIMEOUT_MS = 120_000;

/**
 * @typedef {object} UploadableFile
 * @property {string} name
 * @property {string} [type] MIME type, as a browser `File` carries it.
 * @property {string} [contentType] MIME type, for a headless caller.
 * @property {Uint8Array|ArrayBuffer} [bytes]
 * @property {() => Promise<ArrayBuffer>} [arrayBuffer]
 */

/** Normalize anything file-shaped into `{fileName, contentType, bytes}`. */
export async function readFile(file) {
  if (!file || typeof file !== 'object') throw new TypeError('not a file');
  const fileName = String(file.name ?? file.fileName ?? 'file');
  const contentType = String(file.contentType ?? file.type ?? 'application/octet-stream');

  let bytes = file.bytes;
  if (!bytes && typeof file.arrayBuffer === 'function') bytes = await file.arrayBuffer();
  if (!bytes) throw new TypeError(`"${fileName}" carries no bytes and cannot produce any`);
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!view.length) throw new Error(`"${fileName}" is empty`);
  if (view.length > MAX_UPLOAD_BYTES) {
    throw new Error(`"${fileName}" is ${view.length} bytes, over the ${MAX_UPLOAD_BYTES} limit`);
  }
  return { fileName, contentType, bytes: view };
}

/** A FileList, an array, or one file — always an array. */
export const toFileArray = (files) => {
  if (!files) return [];
  if (Array.isArray(files)) return files;
  if (typeof files.length === 'number') return Array.from(files);
  return [files];
};

/** The resource id, out of whichever shape `resource:create` answered with. */
function resourceIdFrom(ack) {
  const data = ack?.data ?? {};
  return data.resource?.id ?? data.resource?.resourceId ?? data.resources?.[0]?.id ?? null;
}

/**
 * Upload one file and return its resource id.
 *
 * Never throws: every failure comes back as `{ok: false, detail}`, because a
 * multi-file upload reports per file and one bad file must not lose the rest.
 *
 * @param {object} options
 * @param {import('../socket/ValuSocket.js').ValuSocket} options.socket
 * @param {UploadableFile} options.file
 * @param {string} options.belonging Where the resource lands.
 * @param {string} [options.networkId]
 * @param {string} [options.grantToken] Single-use application resource grant.
 * @param {Function} [options.fetchImpl]
 * @returns {Promise<{ok: true, resourceId: string, fileName: string}|{ok: false, fileName: string, detail: string}>}
 */
export async function uploadResource({ socket, file, belonging, networkId, grantToken, fetchImpl }) {
  let read;
  try {
    read = await readFile(file);
  } catch (error) {
    return { ok: false, fileName: String(file?.name ?? 'file'), detail: error?.message ?? String(error) };
  }
  const { fileName, contentType, bytes } = read;
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    return { ok: false, fileName, detail: 'no fetch available to put the bytes with' };
  }

  const create = await socket.emit('resource:create', {
    resource: {
      metadata: { fileName, fileSize: bytes.length, contentType, fileDate: new Date().toISOString() },
    },
    ...(networkId ? { networkId } : {}),
    belonging,
    ...(grantToken ? { grantToken } : {}),
  }, STEP_TIMEOUT_MS);
  if (isAckError(create)) return { ok: false, fileName, detail: ackErrorMessage(create, 'resource:create failed') };

  const resourceId = resourceIdFrom(create);
  if (!resourceId) return { ok: false, fileName, detail: 'resource:create returned no resource id' };

  const link = await socket.emit('resource:getUploadLink', { resourceId }, STEP_TIMEOUT_MS);
  if (isAckError(link)) return { ok: false, fileName, detail: ackErrorMessage(link, 'resource:getUploadLink failed') };
  const url = link?.data?.url;
  if (typeof url !== 'string' || !url) {
    return { ok: false, fileName, detail: 'resource:getUploadLink returned no url' };
  }

  try {
    const put = await doFetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        // A resumable session URL takes the whole payload in one request when
        // the range spans the file.
        'Content-Range': `bytes 0-${bytes.length - 1}/${bytes.length}`,
      },
      body: new Uint8Array(bytes),
      ...(typeof AbortSignal?.timeout === 'function' ? { signal: AbortSignal.timeout(PUT_TIMEOUT_MS) } : {}),
    });
    if (!put || put.status < 200 || put.status >= 300) {
      const body = await put?.text?.().catch(() => '') ?? '';
      return { ok: false, fileName, detail: `bucket upload failed: HTTP ${put?.status}${body ? ` ${String(body).slice(0, 300)}` : ''}` };
    }
  } catch (error) {
    return { ok: false, fileName, detail: `bucket upload error: ${error?.message ?? error}` };
  }

  const complete = await socket.emit('resource:completeUploadLink', { resourceId }, STEP_TIMEOUT_MS);
  if (isAckError(complete)) {
    return { ok: false, fileName, detail: ackErrorMessage(complete, 'resource:completeUploadLink failed') };
  }

  return { ok: true, resourceId, fileName };
}

/**
 * Upload every file, in order, and report per file.
 *
 * Sequential on purpose: the resource ids come back in the caller's order, and
 * the pastes downstream (`room:changePropContent`) place content in the order
 * they are given.
 *
 * @returns {Promise<{resolved: Array<{id: string, fileName: string}>, failed: Array<{fileName: string, error: string}>}>}
 */
export async function uploadResources({ socket, files, belonging, networkId, grantToken, fetchImpl }) {
  const resolved = [];
  const failed = [];
  for (const file of toFileArray(files)) {
    const result = await uploadResource({ socket, file, belonging, networkId, grantToken, fetchImpl });
    if (result.ok) resolved.push({ id: result.resourceId, fileName: result.fileName });
    else failed.push({ fileName: result.fileName, error: result.detail });
  }
  return { resolved, failed };
}

/**
 * A staging session for link copies — `uploadSession:{userId}/{sessionId}`.
 *
 * The CMS refuses `moveToProp` from a resource linked straight under the
 * prop's own belonging ("Invalid prop resources"): the move must come FROM a
 * staging source. The app mints one the same way
 * (RoomsService.#pasteIntoLoadedProp), and the payload is genuinely empty —
 * not an envelope.
 */
export async function createUploadSession(socket, userId) {
  const ack = await socket.emit('resource:createAndSubscribeToUploadSession', {}, STEP_TIMEOUT_MS);
  if (isAckError(ack)) throw new Error(ackErrorMessage(ack, 'failed to create an upload session'));
  const uploadSessionId = ack?.data?.uploadSessionId;
  if (!uploadSessionId) throw new Error('the upload session has no id');
  return `uploadSession:${userId}/${uploadSessionId}`;
}
