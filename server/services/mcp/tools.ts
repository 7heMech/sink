import type { H3Event } from 'h3'
import type { EditLink, Link } from '#shared/schemas/link'
import { createError } from 'h3'
import { z } from 'zod'
import {
  CreateLinkSchema,
  DeleteLinkSchema,
  EditLinkSchema,
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
  metricTypes,
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

export interface McpTool {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  annotations: McpToolAnnotations
  handler: (event: H3Event, args: Record<string, unknown>) => Promise<unknown>
}

const statusProperty = {
  type: 'string',
  enum: ['active', 'expired', 'all'],
  default: 'active',
  description: 'Expiration status filter.',
} as const

const tagProperty = {
  type: 'string',
  description: 'Exact tag filter, normalized to lowercase.',
} as const

const linkFilterProperties = {
  q: {
    type: 'string',
    description: 'Case-insensitive substring matched against slug, URL, comment, or tag. Limited to 48 UTF-8 bytes.',
  },
  url: {
    type: 'string',
    description: 'Target URL matched exactly.',
  },
  tag: tagProperty,
  status: statusProperty,
} as const

/** Writable link fields, mirroring the create and edit REST contracts. */
const linkWriteProperties = {
  url: { type: 'string', description: 'The target URL.' },
  slug: { type: 'string', description: 'The short link slug.' },
  comment: { type: 'string', description: 'Optional internal comment.' },
  expiration: { type: 'integer', description: 'Expiration timestamp in unix seconds. Must be in the future.' },
  title: { type: 'string', description: 'Custom title for the link preview.' },
  description: { type: 'string', description: 'Custom description for the link preview.' },
  image: { type: 'string', description: 'Custom image for the link preview.' },
  apple: { type: 'string', description: 'Apple App Store redirect URL.' },
  google: { type: 'string', description: 'Google Play Store redirect URL.' },
  cloaking: { type: 'boolean', description: 'Mask the destination URL behind the short link.' },
  redirectWithQuery: { type: 'boolean', description: 'Append incoming query parameters to the destination URL.' },
  password: { type: 'string', description: 'Password protecting the link.' },
  unsafe: { type: 'boolean', description: 'Show a warning page before redirecting.' },
  geo: {
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'Geo-routing rules mapping a two-letter country code to a URL.',
  },
  tags: {
    type: 'array',
    items: { type: 'string' },
    maxItems: 10,
    description: 'Up to 10 tags, each 1-32 characters.',
  },
} as const

/** Analytics dimensions shared by every stats tool, matching QuerySchema. */
const analyticsFilterProperties = {
  id: { type: 'string', description: 'Comma-separated link ids to filter on.' },
  slug: { type: 'string', description: 'Comma-separated slugs to filter on.' },
  url: { type: 'string', description: 'Comma-separated destination URLs to filter on.' },
  startAt: { type: 'integer', description: 'Start of the window, unix seconds.' },
  endAt: { type: 'integer', description: 'End of the window, unix seconds.' },
  referer: { type: 'string', description: 'Comma-separated referers to filter on.' },
  country: { type: 'string', description: 'Comma-separated country codes to filter on.' },
  region: { type: 'string', description: 'Comma-separated regions to filter on.' },
  city: { type: 'string', description: 'Comma-separated cities to filter on.' },
  timezone: { type: 'string', description: 'Comma-separated visitor timezones to filter on.' },
  language: { type: 'string', description: 'Comma-separated visitor languages to filter on.' },
  os: { type: 'string', description: 'Comma-separated operating systems to filter on.' },
  browser: { type: 'string', description: 'Comma-separated browsers to filter on.' },
  browserType: { type: 'string', description: 'Comma-separated browser types to filter on.' },
  device: { type: 'string', description: 'Comma-separated devices to filter on.' },
  deviceType: { type: 'string', description: 'Comma-separated device types to filter on.' },
} as const

function objectSchema(properties: Record<string, unknown>, required?: string[]) {
  return {
    type: 'object',
    properties,
    ...(required?.length ? { required } : {}),
    additionalProperties: false,
  }
}

export const mcpTools: McpTool[] = [
  {
    name: 'list_links',
    title: 'List links',
    description: 'List short links newest first, with cursor pagination. Use search_links when looking for a specific link.',
    inputSchema: objectSchema({
      limit: { type: 'integer', minimum: 1, maximum: 1000, default: 20, description: 'Maximum number of links to return.' },
      cursor: { type: 'string', description: 'Pagination cursor returned by a previous call.' },
      sort: { type: 'string', enum: ['az', 'za', 'newest', 'oldest'], default: 'newest', description: 'Sort order.' },
      tag: tagProperty,
      status: statusProperty,
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    async handler(event, args) {
      await assertLinkStoreReady(event)
      const query = ListLinksQuerySchema.parse(args)

      const list = await listLinks(event, query)
      return { ...list, links: sanitizeLinksPassword(list.links) }
    },
  },
  {
    name: 'search_links',
    title: 'Search links',
    description: 'Search links by keyword or exact destination URL. One of `q` or `url` is required; without either the result is empty.',
    inputSchema: objectSchema({
      ...linkFilterProperties,
      limit: { type: 'integer', minimum: 1, maximum: 1000, default: 20, description: 'Maximum number of matches to return.' },
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
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
    title: 'Get link',
    description: 'Read a single short link by slug, including its stored metadata.',
    inputSchema: objectSchema({
      slug: { type: 'string', description: 'The slug of the link to read.' },
    }, ['slug']),
    annotations: { readOnlyHint: true, openWorldHint: false },
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
    title: 'Count links',
    description: 'Count links matching an optional keyword, URL, tag, or expiration status.',
    inputSchema: objectSchema(linkFilterProperties),
    annotations: { readOnlyHint: true, openWorldHint: false },
    async handler(event, args) {
      await assertLinkStoreReady(event)
      const query = LinkFilterQuerySchema.parse(args)

      return { count: await countLinks(event, query) }
    },
  },
  {
    name: 'list_tags',
    title: 'List tags',
    description: 'List every tag currently in use, with the number of links carrying it.',
    inputSchema: objectSchema({}),
    annotations: { readOnlyHint: true, openWorldHint: false },
    async handler(event) {
      await assertLinkStoreReady(event)
      return { tags: await listTags(event) }
    },
  },
  {
    name: 'create_link',
    title: 'Create link',
    description: 'Create a short link. Fails when the slug is already taken; use upsert_link to reuse an existing link instead.',
    inputSchema: objectSchema(linkWriteProperties, ['url']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
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
    title: 'Update link',
    description: 'Replace an existing link identified by slug. Every writable field is overwritten and any omitted optional field is cleared, so read the link with get_link first and send it back complete.',
    inputSchema: objectSchema(linkWriteProperties, ['url', 'slug']),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
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
    title: 'Upsert link',
    description: 'Return the existing link for a slug, or create it when absent. The result reports whether it was `created` or `existing`.',
    inputSchema: objectSchema(linkWriteProperties, ['url']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
    title: 'Delete link',
    description: 'Permanently delete a short link. Existing traffic to the slug stops resolving immediately.',
    inputSchema: objectSchema({
      slug: { type: 'string', description: 'The slug of the link to delete.' },
    }, ['slug']),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
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
    title: 'Get analytics counters',
    description: 'Total visits, unique visitors, and referer counts over the access log, optionally filtered by link and visitor dimensions.',
    inputSchema: objectSchema(analyticsFilterProperties),
    annotations: { readOnlyHint: true, openWorldHint: false },
    async handler(event, args) {
      const query = QuerySchema.parse(args)
      return await useWAE(event, buildCountersQuery(query, event))
    },
  },
  {
    name: 'get_analytics_views',
    title: 'Get analytics views',
    description: 'Visits and visitors bucketed over time. Use `unit` to pick the bucket size and `clientTimezone` to bucket in a specific timezone.',
    inputSchema: objectSchema({
      ...analyticsFilterProperties,
      unit: { type: 'string', enum: ['minute', 'hour', 'day'], description: 'Time bucket size.' },
      clientTimezone: { type: 'string', default: 'Etc/UTC', description: 'IANA timezone used to bucket timestamps.' },
    }, ['unit']),
    annotations: { readOnlyHint: true, openWorldHint: false },
    async handler(event, args) {
      const query = ViewsQuerySchema.parse(args)
      return await useWAE(event, buildViewsQuery(query, event))
    },
  },
  {
    name: 'get_analytics_metrics',
    title: 'Get analytics metrics',
    description: `Top values for one access-log dimension, ordered by visits. Valid \`type\` values: ${metricTypes.join(', ')}.`,
    inputSchema: objectSchema({
      ...analyticsFilterProperties,
      type: { type: 'string', enum: [...metricTypes], description: 'The dimension to group by.' },
      limit: { type: 'integer', minimum: 1, description: 'Maximum number of rows to return.' },
    }, ['type']),
    annotations: { readOnlyHint: true, openWorldHint: false },
    async handler(event, args) {
      const query = MetricsQuerySchema.parse(args)
      return await useWAE(event, buildMetricsQuery(query, event))
    },
  },
]

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
