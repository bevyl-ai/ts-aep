// A Cloudflare Worker over the browser bundle: POST an .aep, get the saved
// bytes back (parse -> save through memfs). Driven by workers-run.ts.
import * as py_aep from "../../dist/browser/browser.js";

export default {
  async fetch(request: Request): Promise<Response> {
    if (py_aep.fsBackend() !== "memory") return new Response("not on the memory fs", { status: 500 });
    try {
      py_aep.memfs.clear();
      py_aep.memfs.write("/in.aep", new Uint8Array(await request.arrayBuffer()));
      py_aep.parse("/in.aep").project.save("/out.aep");
      return new Response(py_aep.memfs.read("/out.aep"));
    } catch (e: any) {
      return new Response(`${e?.constructor?.name}: ${e?.message}`, { status: 500 });
    }
  },
};
