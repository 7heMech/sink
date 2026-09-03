import type { H3Event } from 'h3'
import type { JsonRpcId, JsonRpcRequest, McpResponse } from './protocol'
import type { McpToolResult } from './tools'
import { getHeader, getRequestHost, readRawBody } from 'h3'
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

function resultMeta() {
  return { [META_SERVER_INFO]: MCP_SERVER_INFO }
}

function listedTools() {
  return mcpTools.map(({ name, title, description, inputSchema, annotations }) => ({
    name,
    title,
    description,
    inputSchema,
    annotations,
  }))
}

function methodNotFound(id: JsonRpcId | undefined, method: string): McpResponse {
  return jsonRpcError(id, {
    code: JsonRpcErrorCode.MethodNotFound,
    message: `Method not found: ${method}`,
  }, 404)
}

type ToolCallOutcome = { error: McpResponse } | { result: McpToolResult }

async function runToolCall(event: H3Event, request: JsonRpcRequest): Promise<ToolCallOutcome> {
  const name = request.params?.name
  if (typeof name !== 'string') {
    return {
      error: jsonRpcError(request.id, {
        code: JsonRpcErrorCode.InvalidParams,
        message: 'params.name is required',
      }, 400),
    }
  }

  const tool = mcpToolsByName.get(name)
  if (!tool) {
    return {
      error: jsonRpcError(request.id, {
        code: JsonRpcErrorCode.InvalidParams,
        message: `Unknown tool: ${name}`,
      }, 400),
    }
  }

  const args = request.params?.arguments
  const result = await callMcpTool(event, tool, args && typeof args === 'object' && !Array.isArray(args)
    ? args as Record<string, unknown>
    : {})

  return { result }
}

/**
 * Dispatch for the stateless revision: every request carries its own protocol
 * version, identity, and capabilities, so nothing is remembered between calls.
 */
async function dispatchModern(event: H3Event, request: JsonRpcRequest): Promise<McpResponse> {
  const id = request.id as JsonRpcId

  switch (request.method) {
    case 'server/discover':
      return jsonRpcResult(id, {
        resultType: 'complete',
        supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
        capabilities: SERVER_CAPABILITIES,
        instructions: INSTRUCTIONS,
        ...CACHE_HINTS,
        _meta: resultMeta(),
      })

    case 'tools/list':
      return jsonRpcResult(id, {
        resultType: 'complete',
        tools: listedTools(),
        ...CACHE_HINTS,
        _meta: resultMeta(),
      })

    case 'tools/call': {
      const outcome = await runToolCall(event, request)
      if ('error' in outcome)
        return outcome.error

      return jsonRpcResult(id, {
        resultType: 'complete',
        ...outcome.result,
        _meta: resultMeta(),
      })
    }

    // `ping` was removed in this revision, so it falls through to 404.
    default:
      return methodNotFound(id, request.method)
  }
}

/**
 * Dispatch for initialization-based revisions. The handshake is answered
 * without minting a session, which those revisions permit, so the endpoint
 * stays stateless for every client era.
 */
async function dispatchLegacy(event: H3Event, request: JsonRpcRequest): Promise<McpResponse> {
  const id = request.id as JsonRpcId

  switch (request.method) {
    case 'initialize': {
      const requested = request.params?.protocolVersion
      const negotiated = typeof requested === 'string' && LEGACY_PROTOCOL_VERSIONS.includes(requested as typeof LEGACY_PROTOCOL_VERSIONS[number])
        ? requested
        : LEGACY_PROTOCOL_VERSIONS[0]

      return jsonRpcResult(id, {
        protocolVersion: negotiated,
        capabilities: SERVER_CAPABILITIES,
        serverInfo: MCP_SERVER_INFO,
        instructions: INSTRUCTIONS,
      })
    }

    case 'tools/list':
      return jsonRpcResult(id, { tools: listedTools() })

    case 'tools/call': {
      const outcome = await runToolCall(event, request)
      return 'error' in outcome ? outcome.error : jsonRpcResult(id, { ...outcome.result })
    }

    case 'ping':
      return jsonRpcResult(id, {})

    default:
      return methodNotFound(id, request.method)
  }
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

  if (declaredVersion === MCP_PROTOCOL_VERSION) {
    const invalid = validateRequestHeaders(event, request)
    return invalid ?? await dispatchModern(event, request)
  }

  if (request.method === 'initialize' || declaredVersion === undefined || LEGACY_PROTOCOL_VERSIONS.includes(declaredVersion as typeof LEGACY_PROTOCOL_VERSIONS[number]))
    return await dispatchLegacy(event, request)

  return unsupportedProtocolVersion(request.id, declaredVersion)
}
