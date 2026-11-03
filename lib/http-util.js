/**
 * Small HTTP helpers shared by the control routes.
 */

/** Maximum JSON body this plugin accepts, in bytes. */
const DEFAULT_LIMIT = 8_192;

/**
 * Write one JSON response.
 *
 * @param {import('node:http').ServerResponse} response
 * @param {number} status
 * @param {unknown} payload
 */
export function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body, 'utf8'),
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

/**
 * Read and parse one JSON request body.
 *
 * @param {import('node:http').IncomingMessage} request
 * @param {number} [limit] maximum accepted bytes
 * @returns {Promise<any>} the parsed value, or `undefined` when empty
 */
export async function readJsonBody(request, limit = DEFAULT_LIMIT) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > limit) {
      throw new Error(`request body exceeds ${limit} bytes`);
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text.length === 0) return undefined;
  return JSON.parse(text);
}
