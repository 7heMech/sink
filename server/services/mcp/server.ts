import type { H3Event } from 'h3'
import type { JsonRpcId, JsonRpcRequest, McpResponse } from './protocol'
import { createError, getHeader, getRequestHost, readRawBody, setResponseHeader } from 'h3'
import {
  isJsonRpcRequest,
  jsonRpcError,
  JsonRpcErrorCode,
  jsonRpcResult,
  LEGACY_PROTOCOL_VERSIONS,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_INFO,
  META_SERVER_INFO,
  readDeclaredProtocolVersion,
  SUPPORTED_PROTOCOL_VERSIONS,
  unsupportedProtocolVersion,
  validateRequestHeaders,
} from './protocol'
import {
  callMcpTool,
  mcpTools,
  mcpToolsByName,
} from './tools'

const INSTRUCTIONS = [
  'Sink is a link shortener with built-in analytics.',
  'Links are addressed by their slug; create_link generates one when it is omitted.',
  'update_link replaces every writable field, so read the link with get_link first and send it back complete.',
  'The analytics tools read a sampled access log, so counts are estimates rather than exact totals.',
].join(' ')

const SERVER_CAPABILITIES = {
  tools: { listChanged: false },
}

/**
 * Caching hints the stateless revision requires on every `server/discover` and
 * `tools/list` result. Both answers are compile-time constants that hold no
 * per-caller data, so they are public and only change when the app is
 * redeployed; an hour of client-side freshness costs nothing.
 */
const CACHE_HINTS = {
  ttlMs: 3_600_000,
  cacheScope: 'public',
} as const

function isLegacyVersion(version: string | undefined): boolean {
  return LEGACY_PROTOCOL_VERSIONS.includes(version as typeof LEGACY_PROTOCOL_VERSIONS[number])
}

/** Older clients negotiate at initialize; an unknown request falls back to the newest legacy revision. */
function negotiateLegacyVersion(requested: unknown): string {
  return typeof requested === 'string' && isLegacyVersion(requested) ? requested : LEGACY_PROTOCOL_VERSIONS[0]
}

function methodNotFound(id: JsonRpcId | undefined, method: string): McpResponse {
  return jsonRpcError(id, {
    code: JsonRpcErrorCode.MethodNotFound,
    message: `Method not found: ${method}`,
  }, 404)
}

function invalidParams(id: JsonRpcId | undefined, message: string): McpResponse {
  return jsonRpcError(id, { code: JsonRpcErrorCode.InvalidParams, message }, 400)
}

/** Tool arguments are an object or nothing; anything else is treated as no arguments. */
function toolArguments(params: JsonRpcRequest['params']): Record<string, unknown> {
  const args = params?.arguments
  return args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {}
}

/**
 * Single dispatch for both protocol eras. The stateless revision wraps every
 * result in `resultType` and server `_meta`, and every request carries its own
 * version, identity, and capabilities, so nothing is remembered between calls.
 * Initialization-based revisions answer the handshake without minting a
 * session, which those revisions permit, keeping the endpoint stateless.
 */
async function dispatch(event: H3Event, request: JsonRpcRequest, stateless: boolean): Promise<McpResponse> {
  const id = request.id as JsonRpcId
  const complete = (result: Record<string, unknown> = {}) => jsonRpcResult(id, stateless
    ? { resultType: 'complete', ...result, _meta: { [META_SERVER_INFO]: MCP_SERVER_INFO } }
    : result)

  // Only the stateless revision defines caching hints on its cacheable results.
  const cacheHints = stateless ? CACHE_HINTS : {}

  switch (request.method) {
    case 'initialize':
      return jsonRpcResult(id, {
        protocolVersion: negotiateLegacyVersion(request.params?.protocolVersion),
        capabilities: SERVER_CAPABILITIES,
        serverInfo: MCP_SERVER_INFO,
        instructions: INSTRUCTIONS,
      })

    case 'server/discover':
      return stateless
        ? complete({
            supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
            capabilities: SERVER_CAPABILITIES,
            instructions: INSTRUCTIONS,
            ...cacheHints,
          })
        : methodNotFound(id, request.method)

    case 'tools/list':
      return complete({ tools: mcpTools.map(({ handler, ...tool }) => tool), ...cacheHints })

    case 'tools/call': {
      const name = request.params?.name
      if (typeof name !== 'string')
        return invalidParams(id, 'params.name is required')

      const tool = mcpToolsByName.get(name)
      if (!tool)
        return invalidParams(id, `Unknown tool: ${name}`)

      return complete({ ...await callMcpTool(event, tool, toolArguments(request.params)) })
    }

    // `ping` went away with the session it kept alive, so the stateless
    // revision answers the 404 the transport mandates for unknown methods.
    case 'ping':
      return stateless ? methodNotFound(id, request.method) : complete()

    default:
      return methodNotFound(id, request.method)
  }
}

/**
 * The 2026-07-28 revision removed the standalone GET stream and protocol-level
 * sessions, so POST is the only method this endpoint answers.
 */
export function rejectNonPostMethod(event: H3Event): never {
  setResponseHeader(event, 'Allow', 'POST')
  throw createError({
    status: 405,
    statusText: 'Method Not Allowed',
  })
}

/**
 * Rejects cross-origin browser requests, which cookie-based Cloudflare Access
 * sessions would otherwise let a malicious page replay against this endpoint.
 * Non-browser MCP clients do not send an `Origin` header.
 */
function isAllowedOrigin(event: H3Event): boolean {
  const origin = getHeader(event, 'origin')
  if (!origin)
    return true

  try {
    return new URL(origin).host === getRequestHost(event)
  }
  catch {
    return false
  }
}

export async function handleMcpPost(event: H3Event): Promise<McpResponse> {
  if (!isAllowedOrigin(event)) {
    return jsonRpcError(undefined, {
      code: JsonRpcErrorCode.InvalidRequest,
      message: 'Origin not allowed',
    }, 403)
  }

  let message: unknown
  try {
    message = JSON.parse(await readRawBody(event) || '')
  }
  catch {
    return jsonRpcError(undefined, {
      code: JsonRpcErrorCode.ParseError,
      message: 'Request body is not valid JSON',
    }, 400)
  }

  if (Array.isArray(message)) {
    return jsonRpcError(undefined, {
      code: JsonRpcErrorCode.InvalidRequest,
      message: 'Batched messages are not supported; send one JSON-RPC message per request',
    }, 400)
  }

  if (!isJsonRpcRequest(message)) {
    return jsonRpcError(undefined, {
      code: JsonRpcErrorCode.InvalidRequest,
      message: 'Request body must be a single JSON-RPC 2.0 request or notification',
    }, 400)
  }

  const request = message
  const declaredVersion = readDeclaredProtocolVersion(event, request)

  // Notifications carry no id and get no response body.
  if (request.id === undefined) {
    return request.method.startsWith('notifications/')
      ? { status: 202, body: null }
      : jsonRpcError(undefined, {
          code: JsonRpcErrorCode.InvalidRequest,
          message: `Method ${request.method} must be sent as a request with an id`,
        }, 400)
  }

  if (declaredVersion === MCP_PROTOCOL_VERSION)
    return validateRequestHeaders(event, request) ?? await dispatch(event, request, true)

  if (request.method === 'initialize' || declaredVersion === undefined || isLegacyVersion(declaredVersion))
    return await dispatch(event, request, false)

  return unsupportedProtocolVersion(request.id, declaredVersion)
}
