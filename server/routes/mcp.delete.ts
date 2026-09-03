export default eventHandler((event) => {
  // The 2026-07-28 revision removed protocol-level sessions, so there is
  // nothing for a client to terminate.
  setResponseHeader(event, 'Allow', 'POST')
  throw createError({
    status: 405,
    statusText: 'Method Not Allowed',
  })
})
