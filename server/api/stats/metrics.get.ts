import type { H3Event } from 'h3'
import { QuerySchema } from '@@/schemas/query'
import { z } from 'zod'

const { select } = SqlBricks

const MetricsQuerySchema = QuerySchema.extend({
  type: z.string(),
  // format: z.string().optional(), // REMOVE THIS LINE
})

function query2sql(query: z.infer<typeof MetricsQuerySchema>, event: H3Event): string {
  const filter = query2filter(query)
  const { dataset } = useRuntimeConfig(event)

  // @ts-expect-error todo
  const sql = select(`${logsMap[query.type]} as name, SUM(_sample_interval) as count`).from(dataset).where(filter).groupBy('name').orderBy('count DESC').limit(query.limit)
  appendTimeFilter(sql, query)
  return sql.toString()
}

export default eventHandler(async (event) => {
  // The query will no longer have 'format' after validation by the updated schema
  const query = await getValidatedQuery(event, MetricsQuerySchema.parse);
  const sql = query2sql(query, event); // query2sql should be the existing one

  // Directly return the data fetched by useWAE (which should be JSON)
  return useWAE(event, sql);
})
