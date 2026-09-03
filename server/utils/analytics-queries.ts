import type { H3Event } from 'h3'
import type { RawBuilder } from 'kysely'
import type { Query } from '#shared/schemas/query'
import type { BlobsMap, DoublesMap } from './access-log'
import { sql } from 'kysely'
import { z } from 'zod'
import { QuerySchema } from '#shared/schemas/query'
import { blobsMap, doublesMap, logsMap } from './access-log'
import { createAnalyticsQuery } from './analytics-sql'
import { buildAnalyticsFilter } from './query-filter'
import { getSafeTimezone } from './time'

type MetricType = BlobsMap[keyof BlobsMap] | DoublesMap[keyof DoublesMap]

const validMetricTypes = [...Object.values(blobsMap), ...Object.values(doublesMap)] as [MetricType, ...MetricType[]]

export const metricTypes = validMetricTypes as readonly MetricType[]

const viewUnits = { minute: '%Y-%m-%d %H:%i', hour: '%Y-%m-%d %H', day: '%Y-%m-%d' } as const

const ClientTimezoneSchema = z.string()
  .regex(/^[\w+-]+(?:\/[\w+-]+)*$/)
  .max(64)
  .default('Etc/UTC')

export const ViewsQuerySchema = QuerySchema.extend({
  unit: z.enum(['minute', 'hour', 'day']),
  clientTimezone: ClientTimezoneSchema,
})

export const MetricsQuerySchema = QuerySchema.extend({
  type: z.enum(validMetricTypes),
})

export type ViewsQuery = z.infer<typeof ViewsQuerySchema>
export type MetricsQuery = z.infer<typeof MetricsQuerySchema>

function weightedDistinct(column: string): RawBuilder<number> {
  // Weighted distinct count: COUNT(DISTINCT col) * SUM(_sample_interval) / COUNT() ≈ actual distinct count
  return sql<number>`ROUND(COUNT(DISTINCT ${sql.ref(column)}) * SUM(_sample_interval) / COUNT())`
}

function filteredQuery(query: Query, event: H3Event) {
  const filter = buildAnalyticsFilter(query)
  const { dataset } = useRuntimeConfig(event)
  const analyticsQuery = createAnalyticsQuery(dataset)
  return filter ? analyticsQuery.where(filter) : analyticsQuery
}

export function buildCountersQuery(query: Query, event: H3Event) {
  const statement = filteredQuery(query, event).select([
    sql<number>`SUM(_sample_interval)`.as('visits'),
    weightedDistinct(logsMap.ip!).as('visitors'),
    weightedDistinct(logsMap.referer!).as('referers'),
  ])

  return query.id
    ? statement.select(sql.ref('index1').as('id')).groupBy('index1')
    : statement
}

export function buildViewsQuery(query: ViewsQuery, event: H3Event) {
  const timezone = getSafeTimezone(query.clientTimezone)

  return filteredQuery(query, event)
    .select([
      sql<string>`formatDateTime(${sql.ref('timestamp')}, ${sql.lit(viewUnits[query.unit])}, ${sql.lit(timezone)})`.as('time'),
      sql<number>`SUM(_sample_interval)`.as('visits'),
      sql<number>`COUNT(DISTINCT ${sql.ref(logsMap.ip!)})`.as('visitors'),
    ])
    .groupBy('time')
    .orderBy('time')
}

export function buildMetricsQuery(query: MetricsQuery, event: H3Event) {
  const limit = Math.max(0, Math.floor(query.limit))
  const metricColumn = logsMap[query.type] as string

  return filteredQuery(query, event)
    .select([
      sql.ref(metricColumn).as('name'),
      sql<number>`SUM(_sample_interval)`.as('count'),
    ])
    .groupBy('name')
    .orderBy('count', 'desc')
    .limit(sql.lit(limit))
}
