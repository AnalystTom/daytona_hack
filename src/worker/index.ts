import { version } from "../../package.json";

export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/api/health") {
      return Response.json({ ok: true, version });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  },
} satisfies ExportedHandler;
