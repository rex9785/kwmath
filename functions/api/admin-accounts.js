// Removed — replaced by admin-reset-password endpoint
export async function onRequest() {
  return Response.json({ error: 'Not Found' }, { status: 404 });
}
