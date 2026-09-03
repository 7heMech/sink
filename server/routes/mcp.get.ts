export default eventHandler((event) => {
  // The 2026-07-28 revision removed the standalone GET stream; only POST remains.
  setResponseHeader(event, 'Allow', 'POST')
  throw createError({
    status: 405,
    statusText: 'Method Not Allowed',
  })
})
