export const auth = {
  handler: async () => {
    return Response.json({data: null, error: 'Authentication removed in local-first mode'}, {status: 410})
  },
}
