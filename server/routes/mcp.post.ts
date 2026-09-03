import { handleMcpPost } from '../services/mcp/server'

defineRouteMeta({
  openAPI: {
    tags: ['MCP'],
    description: 'Model Context Protocol endpoint (Streamable HTTP). Accepts a single JSON-RPC 2.0 request per POST and answers with a JSON object. Implements the stateless 2026-07-28 revision and still answers the initialization-based revisions used by older clients.',
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['jsonrpc', 'method'],
            properties: {
              jsonrpc: { type: 'string', enum: ['2.0'] },
              id: { type: ['string', 'integer'], description: 'Request id. Omitted for notifications, which are answered with 202.' },
              method: { type: 'string', description: 'One of server/discover, tools/list, tools/call, ping, or initialize for older clients.' },
              params: { type: 'object', additionalProperties: true },
            },
          },
        },
      },
    },
  },
})

export default eventHandler(async (event) => {
  const { status, body } = await handleMcpPost(event)

  setResponseStatus(event, status)
  setResponseHeader(event, 'Cache-Control', 'no-store')
  if (body === null)
    return null

  setResponseHeader(event, 'Content-Type', 'application/json')
  return body
})
