import type { H3Event } from 'h3'
import { getHeader } from 'h3'

/**
 * Protocol revision implemented by the stateless MCP endpoint.
 * See https://modelcontextprotocol.io/specification/2026-07-28
 */
export const MCP_PROTOCOL_VERSION = '2026-07-28'

/**
 * Initialization-based revisions this endpoint still answers so that clients
 * predating the stateless revision keep working. Ordered newest first.
 */
export const LEGACY_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const

export const SUPPORTED_PROTOCOL_VERSIONS = [MCP_PROTOCOL_VERSION, ...LEGACY_PROTOCOL_VERSIONS]

/** Reported as `serverInfo`. The version is this endpoint's, independent of the Sink release. */
export const MCP_SERVER_INFO = {
  name: 'sink',
  title: 'Sink',
  version: '1.0.0',
} as const

export const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion'
export const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities'
export const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo'

/**
 * JSON-RPC codes emitted by this endpoint. `-32020` and above are allocated by
 * the MCP specification; the rest are standard JSON-RPC 2.0 codes.
 */
export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  HeaderMismatch: -32020,
  UnsupportedProtocolVersion: -32022,
} as const

export type JsonRpcId = string | number

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: JsonRpcId
  method: string
  params?: Record<string, unknown>
}

export interface McpResponse {
  status: number
  body: unknown
}

const BASE64_SENTINEL_PREFIX = '=?base64?'
const BASE64_SENTINEL_SUFFIX = '?='

/**
 * Decodes the `=?base64?...?=` sentinel the transport uses for header values
 * that cannot be represented as plain ASCII.
 */
export function decodeHeaderValue(value: string): string {
  if (!value.startsWith(BASE64_SENTINEL_PREFIX) || !value.endsWith(BASE64_SENTINEL_SUFFIX))
    return value

  const encoded = value.slice(BASE64_SENTINEL_PREFIX.length, -BASE64_SENTINEL_SUFFIX.length)
  try {
    const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  }
  catch {
    // An undecodable value cannot match the body, so hand it back unchanged and
    // let header validation reject the request instead of throwing.
    return value
  }
}

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return false

  const message = value as Record<string, unknown>
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string')
    return false

  return message.id === undefined || typeof message.id === 'string' || typeof message.id === 'number'
}

export function jsonRpcResult(id: JsonRpcId, result: Record<string, unknown>, status = 200): McpResponse {
  return {
    status,
    body: {
      jsonrpc: '2.0',
      id,
      result,
    },
  }
}

export function jsonRpcError(id: JsonRpcId | undefined, error: { code: number, message: string, data?: unknown }, status: number): McpResponse {
  return {
    status,
    body: {
      jsonrpc: '2.0',
      ...(id === undefined ? {} : { id }),
      error,
    },
  }
}

export function unsupportedProtocolVersion(id: JsonRpcId | undefined, requested: string): McpResponse {
  return jsonRpcError(id, {
    code: JsonRpcErrorCode.UnsupportedProtocolVersion,
    message: 'Unsupported protocol version',
    data: {
      supported: SUPPORTED_PROTOCOL_VERSIONS,
      requested,
    },
  }, 400)
}

export function headerMismatch(id: JsonRpcId | undefined, message: string): McpResponse {
  return jsonRpcError(id, {
    code: JsonRpcErrorCode.HeaderMismatch,
    message: `Header mismatch: ${message}`,
  }, 400)
}

/**
 * The value the client declared for this request, from `_meta` when present and
 * from the mirrored header otherwise.
 */
export function readDeclaredProtocolVersion(event: H3Event, request: JsonRpcRequest): string | undefined {
  const meta = request.params?._meta as Record<string, unknown> | undefined
  const metaVersion = meta?.[META_PROTOCOL_VERSION]
  if (typeof metaVersion === 'string')
    return metaVersion

  return getHeader(event, 'mcp-protocol-version') || undefined
}

/** The `_meta` entries the stateless revision requires on every request. */
function requiredMeta(id: JsonRpcId | undefined, key: string): McpResponse {
  return jsonRpcError(id, {
    code: JsonRpcErrorCode.InvalidParams,
    message: `params._meta['${key}'] is required`,
  }, 400)
}

/** A mirrored header has to be present and to agree with the body value it mirrors. */
function matchHeader(event: H3Event, id: JsonRpcId | undefined, header: string, expected: unknown): McpResponse | null {
  const value = getHeader(event, header.toLowerCase())
  if (!value)
    return headerMismatch(id, `the ${header} header is required`)

  return decodeHeaderValue(value) === expected
    ? null
    : headerMismatch(id, `${header} header value '${value}' does not match body value '${String(expected)}'`)
}

/**
 * Validates the headers the Streamable HTTP transport mirrors from the body.
 * The body stays the source of truth, so any disagreement is rejected.
 */
export function validateRequestHeaders(event: H3Event, request: JsonRpcRequest): McpResponse | null {
  const id = request.id
  const meta = request.params?._meta as Record<string, unknown> | undefined

  const metaVersion = meta?.[META_PROTOCOL_VERSION]
  if (typeof metaVersion !== 'string')
    return requiredMeta(id, META_PROTOCOL_VERSION)
  if (meta[META_CLIENT_CAPABILITIES] === undefined)
    return requiredMeta(id, META_CLIENT_CAPABILITIES)

  return matchHeader(event, id, 'MCP-Protocol-Version', metaVersion)
    ?? matchHeader(event, id, 'Mcp-Method', request.method)
    ?? (request.method === 'tools/call' ? matchHeader(event, id, 'Mcp-Name', request.params?.name) : null)
}
