import type { H3Event } from 'h3'
import type { EditLink, Link } from '#shared/schemas/link'
import { createError } from 'h3'
import { z } from 'zod'
import {
  CreateLinkSchema,
  DeleteLinkSchema,
  EditLinkSchema,
  LinkFieldsSchema,
  LinkFilterQuerySchema,
  LinkSlugQuerySchema,
  ListLinksQuerySchema,
  SearchLinksQuerySchema,
} from '#shared/schemas/link'
import { QuerySchema } from '#shared/schemas/query'
import {
  buildCountersQuery,
  buildMetricsQuery,
  buildViewsQuery,
  MetricsQuerySchema,
  ViewsQuerySchema,
} from '../../utils/analytics-queries'
import { useWAE } from '../../utils/cloudflare'
import { sanitizeLinkPassword, sanitizeLinksPassword } from '../../utils/link-password'
import {
  applyEditableLinkPassword,
  assertLinkWritesAllowed,
  buildLinkResponse,
  detectUnsafeLink,
  hashLinkPasswordForCreate,
  mergeEditableLink,
  prepareIncomingLink,
} from '../../utils/link-processing'
import {
  countLinks,
  createLink,
  deleteLink,
  getAnyAuthoritativeLink,
  getAuthoritativeLink,
  getLinkWithMetadata,
  listLinks,
  listTags,
  normalizeSlug,
  searchLinks,
  updateLink,
} from '../../utils/link-store'
import { assertLinkStoreReady } from '../link-store/migration'

export interface McpToolAnnotations {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

interface McpToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations: McpToolAnnotations
  handler: (event: H3Event, args: Record<string, unknown>) => Promise<unknown>
}

export interface McpTool extends McpToolDefinition {
  title: string
}

/**
 * Tool input schemas are generated from the same zod contracts the handlers
 * parse with, so the advertised shape cannot drift from what is accepted.
 */
function inputSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema, ...json } = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' })
  return { ...json, additionalProperties: false }
}

/** Create and upsert generate a slug when one is omitted; the other write fields match the edit contract. */
const CreateLinkArgsSchema = LinkFieldsSchema.partial({ slug: true })

/** Analytics filters, minus the row limit the counter and time-series tools ignore. */
const AnalyticsFilterSchema = QuerySchema.omit({ limit: true })

const FILTER_NOTE = 'Every filter accepts a comma-separated list of values.'

const toolDefinitions: McpToolDefinition[] = [
  {
    name: 'list_links',
    description: 'List short links newest first, with cursor pagination. Use search_links when looking for a specific link.',
    inputSchema: inputSchema(ListLinksQuerySchema),
    annotations: { readOnlyHint: true },
    async handler(event, args) {
      await assertLinkStoreReady(event)
      const query = ListLinksQuerySchema.parse(args)

      const list = await listLinks(event, query)
      return { ...list, links: sanitizeLinksPassword(list.links) }
    },
  },
  {
    name: 'search_links',
    description: 'Search links by keyword or exact destination URL. One of `q` or `url` is required; without either the result is empty.',
    inputSchema: inputSchema(SearchLinksQuerySchema),
    annotations: { readOnlyHint: true },
    async handler(event, args) {
      await assertLinkStoreReady(event)
      const query = SearchLinksQuerySchema.parse(args)

      if (!query.q && !query.url)
        return { links: [] }

      return { links: await searchLinks(event, query) }
    },
  },
  {
    name: 'get_link',
    description: 'Read a single short link by slug, including its stored metadata.',
    inputSchema: inputSchema(LinkSlugQuerySchema),
    annotations: { readOnlyHint: true },
    async handler(event, args) {
      await assertLinkStoreReady(event)
      const { slug } = LinkSlugQuerySchema.parse(args)
      const { link, metadata } = await getLinkWithMetadata(event, normalizeSlug(event, slug))
      if (!link)
        throw createError({ status: 404, statusText: 'Link not found' })

      return sanitizeLinkPassword({ ...metadata, ...link })
    },
  },
  {
    name: 'count_links',
    description: 'Count links matching an optional keyword, URL, tag, or expiration status.',
    inputSchema: inputSchema(LinkFilterQuerySchema),
    annotations: { readOnlyHint: true },
    async handler(event, args) {
      await assertLinkStoreReady(event)
      const query = LinkFilterQuerySchema.parse(args)

      return { count: await countLinks(event, query) }
    },
  },
  {
    name: 'list_tags',
    description: 'List every tag currently in use, with the number of links carrying it.',
    inputSchema: inputSchema(z.object({})),
    annotations: { readOnlyHint: true },
    async handler(event) {
      await assertLinkStoreReady(event)
      return { tags: await listTags(event) }
    },
  },
  {
    name: 'create_link',
    description: 'Create a short link. Fails when the slug is already taken; use upsert_link to reuse an existing link instead.',
    inputSchema: inputSchema(CreateLinkArgsSchema),
    annotations: { destructiveHint: false, idempotentHint: false },
    async handler(event, args) {
      await assertLinkStoreReady(event)
      const link = CreateLinkSchema.parse(args)

      await prepareIncomingLink(event, link)
      await hashLinkPasswordForCreate(link)

      if (!await createLink(event, link))
        throw createError({ status: 409, statusText: 'Link already exists' })

      return buildLinkResponse(event, link)
    },
  },
  {
    name: 'update_link',
    description: 'Replace an existing link identified by slug. Every writable field is overwritten and any omitted optional field is cleared, so read the link with get_link first and send it back complete.',
    inputSchema: inputSchema(LinkFieldsSchema),
    annotations: { destructiveHint: true, idempotentHint: true },
    async handler(event, args) {
      assertLinkWritesAllowed(event, 'edit')
      await assertLinkStoreReady(event)

      const link: EditLink = EditLinkSchema.parse(args)
      link.slug = normalizeSlug(event, link.slug)

      const existingLink: Link | null = await getAnyAuthoritativeLink(event, link.slug)
      if (!existingLink)
        throw createError({ status: 404, statusText: 'Link not found' })

      if (link.url !== existingLink.url)
        await detectUnsafeLink(event, link)

      const newLink = mergeEditableLink(existingLink, link)
      await applyEditableLinkPassword(newLink, link.password)

      if (!await updateLink(event, newLink, { id: existingLink.id, updatedAt: existingLink.updatedAt }))
        throw createError({ status: 409, statusText: 'Link was modified or replaced' })

      return buildLinkResponse(event, newLink)
    },
  },
  {
    name: 'upsert_link',
    description: 'Return the existing link for a slug, or create it when absent. The result reports whether it was `created` or `existing`.',
    inputSchema: inputSchema(CreateLinkArgsSchema),
    annotations: { destructiveHint: false, idempotentHint: true },
    async handler(event, args) {
      await assertLinkStoreReady(event)
      const link = CreateLinkSchema.parse(args)

      await prepareIncomingLink(event, link)

      const existingLink = await getAuthoritativeLink(event, link.slug)
      if (existingLink)
        return { ...buildLinkResponse(event, existingLink), status: 'existing' }

      await hashLinkPasswordForCreate(link)

      if (!await createLink(event, link)) {
        const racedLink = await getAuthoritativeLink(event, link.slug)
        if (racedLink)
          return { ...buildLinkResponse(event, racedLink), status: 'existing' }

        throw createError({ status: 409, statusText: 'Link already exists' })
      }

      return { ...buildLinkResponse(event, link), status: 'created' }
    },
  },
  {
    name: 'delete_link',
    description: 'Permanently delete a short link. Existing traffic to the slug stops resolving immediately.',
    inputSchema: inputSchema(DeleteLinkSchema),
    annotations: { destructiveHint: true, idempotentHint: true },
    async handler(event, args) {
      assertLinkWritesAllowed(event, 'delete')
      await assertLinkStoreReady(event)

      const parsed = DeleteLinkSchema.parse(args)
      const slug = normalizeSlug(event, parsed.slug)
      await deleteLink(event, slug)
      return { slug, deleted: true }
    },
  },
  {
    name: 'get_analytics_counters',
    description: `Total visits, unique visitors, and referer counts over the access log. ${FILTER_NOTE}`,
    inputSchema: inputSchema(AnalyticsFilterSchema),
    annotations: { readOnlyHint: true },
    async handler(event, args) {
      const query = QuerySchema.parse(args)
      return await useWAE(event, buildCountersQuery(query, event))
    },
  },
  {
    name: 'get_analytics_views',
    description: `Visits and visitors bucketed over time by minute, hour, or day. ${FILTER_NOTE}`,
    inputSchema: inputSchema(ViewsQuerySchema.omit({ limit: true })),
    annotations: { readOnlyHint: true },
    async handler(event, args) {
      const query = ViewsQuerySchema.parse(args)
      return await useWAE(event, buildViewsQuery(query, event))
    },
  },
  {
    name: 'get_analytics_metrics',
    description: `Top values for one access-log dimension, ordered by visits. ${FILTER_NOTE}`,
    inputSchema: inputSchema(MetricsQuerySchema),
    annotations: { readOnlyHint: true },
    async handler(event, args) {
      const query = MetricsQuerySchema.parse(args)
      return await useWAE(event, buildMetricsQuery(query, event))
    },
  },
]

/**
 * Titles are the display form of the name (`list_links` becomes `List links`),
 * and annotations fall back to the hints every Sink tool shares.
 */
export const mcpTools: McpTool[] = toolDefinitions.map(tool => ({
  ...tool,
  title: tool.name.replace(/_/g, ' ').replace(/^./, character => character.toUpperCase()),
  annotations: { readOnlyHint: false, openWorldHint: false, ...tool.annotations },
}))

export const mcpToolsByName = new Map(mcpTools.map(tool => [tool.name, tool]))

export interface McpToolResult {
  content: { type: 'text', text: string }[]
  structuredContent?: unknown
  isError?: boolean
}

function toolError(message: string): McpToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  }
}

/**
 * Runs a tool and shapes the outcome as a tool result. Validation and business
 * failures are returned with `isError` so the calling model can self-correct;
 * only unknown tools are reported as JSON-RPC protocol errors by the caller.
 */
export async function callMcpTool(event: H3Event, tool: McpTool, args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const data = await tool.handler(event, args)
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
      structuredContent: data,
    }
  }
  catch (error) {
    if (error instanceof z.ZodError) {
      const issues = error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')
      return toolError(`Invalid arguments for ${tool.name}: ${issues}`)
    }

    const failure = error as { statusCode?: number, statusMessage?: string, message?: string }
    const status = failure.statusCode ? `${failure.statusCode} ` : ''
    return toolError(`${tool.name} failed: ${status}${failure.statusMessage || failure.message || 'Unknown error'}`)
  }
}
