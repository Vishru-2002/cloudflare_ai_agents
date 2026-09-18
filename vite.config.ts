import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    react(),
    // Runs the Worker in workerd alongside Vite, reading wrangler.jsonc for
    // bindings. One `npm run dev` gives hot reload for both the React app and
    // the Worker, and the API is served from the same origin as the SPA.
    cloudflare({
      // Remote bindings default to true, which makes Wrangler open a proxy
      // session against Cloudflare — that needs a registered workers.dev
      // subdomain. Keeping everything local means Durable Objects, D1 and
      // Workflows run on this machine; Workers AI is reached through the REST
      // fallback in worker/ai/client.ts instead. See README.
      remoteBindings: false,
    }),
  ],
  resolve: {
    alias: {
      // One definition of the wire format, shared by the Worker and the SPA.
      "@shared": resolve(here, "shared"),
    },
  },
  // Output paths are managed by the Cloudflare plugin: the SPA lands in
  // dist/client and the Worker bundle beside it. Overriding build.outDir here
  // nests the client inside itself.
});
