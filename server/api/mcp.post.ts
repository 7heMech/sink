import { handleMcpPost } from '../services/mcp/server'

defineRouteMeta({
  openAPI: {
    tags: ['MCP'],
    description: 'Model Context Protocol endpoint (Streamable HTTP, stateless with JSON responses) served by the official @modelcontextprotocol/sdk. Accepts standard MCP messages such as initialize, tools/list, tools/call, and ping. A message without an `id` is a notification and is answered with 202.',
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['jsonrpc', 'method'],
            additionalProperties: true,
            description: '`method` is one of initialize, notifications/initialized, tools/list, tools/call, or ping.',
          },
        },
      },
    },
  },
})

export default eventHandler(async (event) => {
  const response = await handleMcpPost(event)

  setResponseStatus(event, response.status)
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'content-length')
      return
    setResponseHeader(event, key, value)
  })
  setResponseHeader(event, 'Cache-Control', 'no-store')

  const text = await response.text()
  if (!text)
    return null

  setResponseHeader(event, 'Content-Type', 'application/json')
  try {
    return JSON.parse(text)
  }
  catch {
    return text
  }
})
