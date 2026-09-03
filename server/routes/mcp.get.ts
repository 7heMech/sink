import { rejectNonPostMethod } from '../services/mcp/server'

export default eventHandler(rejectNonPostMethod)
