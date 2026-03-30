export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET() {
  return Response.json({ error: "Not found" }, { status: 404 });
}
