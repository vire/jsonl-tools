import { serve } from "bun";
import index from "./index.html";
import bulkAnalyzer from "./bulk-analyzer.html";
import shareViewer from "./share.html";
import { handleDocsRequest } from "./server/docs-page";
import { sitemapXml, robotsTxt } from "./server/seo";
import {
  handleCreateShare,
  handleFetchShare,
  handleDeleteShare,
  MAX_CIPHERTEXT_BYTES,
} from "./server/shares";
import { handleReportAbuse } from "./server/abuse";
import {
  handleLogin,
  handleCallback,
  handleLogout,
  handleMe,
} from "./server/oauth-github";
import {
  handleSetupAccount,
  handleGetAccount,
  handleGetRecoveryBlob,
  handleRotateAccount,
} from "./server/account-store";
import {
  handleListHistory,
  handleDeleteHistory,
  handleUpdateHistory,
  handleReconcile,
} from "./server/history";
import {
  handleMintToken,
  handleListTokens,
  handleRevokeToken,
} from "./server/cli-tokens";
import {
  handleCliUpload,
  handleCliList,
  handleCliDelete,
} from "./server/cli-uploads";
import { capture, recordPageView, validSurface } from "./server/analytics";
import { handleAnalyticsDashboard } from "./server/analytics-dashboard";

// The full route map, exposed as a factory so tests can mount it on a throwaway
// Bun.serve (ephemeral port) and exercise the real wiring — including which
// routes are instrumented and which catch-alls stay bare. `getIp` abstracts
// `server.requestIP`, which only exists after serve() has been called.
export function createRoutes(getIp: (req: Request) => string | undefined) {
  return {
    // Serve index.html for all unmatched routes.
    "/*": index,

    "/bulk-analyzer": bulkAnalyzer,

    // Analytics-free recipient viewer; the client reads :id + #key (plan U4)
    "/s/:id": shareViewer,

    // Server-rendered docs (handleDocsRequest in server/docs-page.ts): complete,
    // crawlable HTML per page with no client JS. The wildcard (rather than
    // ":slug") also covers trailing-slash forms like /docs/cli/, which 301 to the
    // canonical path; a bare ":slug" route would let those fall through to the
    // "/*" SPA catch-all. Like the other page surfaces, docs is intentionally
    // bare (not capture-wrapped) — page-views aren't counted here (KTD2).
    "/docs": handleDocsRequest,
    "/docs/*": handleDocsRequest,

    // Static assets for the server-rendered docs (no bundler involved).
    "/docs.css": () =>
      new Response(Bun.file(new URL("./docs.css", import.meta.url)), {
        headers: { "content-type": "text/css; charset=utf-8" },
      }),
    "/favicon.svg": () =>
      new Response(Bun.file(new URL("./favicon.svg", import.meta.url)), {
        headers: { "content-type": "image/svg+xml" },
      }),

    // Open Graph / Twitter card image (1200×630, scripts/gen-og.ts). Referenced
    // as an absolute og:image URL by the docs head; unfurlers fetch it
    // un-authenticated, so it must be public and cacheable.
    "/og.png": () =>
      new Response(Bun.file(new URL("./og.png", import.meta.url)), {
        headers: {
          "content-type": "image/png",
          "cache-control": "public, max-age=86400",
        },
      }),

    // SEO discovery files (derived from the docs; /s/ is excluded — see seo.ts).
    "/sitemap.xml": () =>
      new Response(sitemapXml(), {
        headers: { "content-type": "application/xml; charset=utf-8" },
      }),
    "/robots.txt": () =>
      new Response(robotsTxt(), {
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),

    // Operator-only usage dashboard (plan U5). Deliberately NOT wrapped by
    // capture() — the dashboard never measures itself (R14) — and returns an
    // opaque bodyless 404 to non-operators (AE4).
    "/admin/analytics": { GET: req => handleAnalyticsDashboard(req) },

    // Usage analytics (plan U3): every NAMED /api/* handler below is wrapped in
    // capture(template, method, req, handler). The template is a literal at the
    // wrap site, so only the route shape is ever stored — never a concrete id.
    // The "/*" and "/api/*" catch-alls and the operator dashboard stay bare, so
    // asset hits, 404s, and self-traffic are never counted. Two GET handlers
    // additionally derive a page-view from their on-load request, which is how
    // the key-bearing home/viewer surfaces are measured without adding any new
    // network call to them (KTD2).

    // Zero-knowledge share API (plan U3 create; U5 hardens fetch lifecycle)
    "/api/shares": {
      POST: req =>
        capture("/api/shares", "POST", req, () =>
          handleCreateShare(req, getIp(req)),
        ),
    },
    "/api/shares/:id": {
      GET: req =>
        capture("/api/shares/:id", "GET", req, () => {
          // Viewer page-view: the /s/:id surface fetches the share on load and
          // labels it X-Anon-Surface: viewer (no session id — KTD3/KTD5).
          if (req.headers.get("x-anon-surface") === "viewer") recordPageView("viewer", req);
          return handleFetchShare(req.params.id, req);
        }),
      DELETE: req =>
        capture("/api/shares/:id", "DELETE", req, () => handleDeleteShare(req, req.params.id)),
    },

    // Abuse report (plan U11) — opaque, rate-limited, no auto-action
    "/api/report": {
      POST: req =>
        capture("/api/report", "POST", req, () =>
          handleReportAbuse(req, getIp(req)),
        ),
    },

    // GitHub OAuth + sessions (plan U7)
    "/api/auth/login": {
      GET: req => capture("/api/auth/login", "GET", req, () => handleLogin(req)),
    },
    "/api/auth/callback": {
      GET: req => capture("/api/auth/callback", "GET", req, () => handleCallback(req)),
    },
    "/api/auth/logout": {
      POST: req => capture("/api/auth/logout", "POST", req, () => handleLogout(req)),
    },
    "/api/auth/me": {
      GET: req =>
        capture("/api/auth/me", "GET", req, () => {
          // Home page-view: the home surface always calls /api/auth/me on load
          // and labels it X-Anon-Surface: home.
          if (req.headers.get("x-anon-surface") === "home") recordPageView("home", req);
          return handleMe(req);
        }),
    },

    // Page-view beacon for the R22-exempt bulk-analyzer (it fires no other
    // /api call on load). Records only a page_view for the validated surface;
    // deliberately NOT wrapped in capture, so it adds no spurious api row.
    // Always 204 and opaque.
    "/api/events": {
      POST: req => {
        const surface = validSurface(req.headers.get("x-anon-surface"));
        if (surface) recordPageView(surface, req);
        return new Response(null, { status: 204 });
      },
    },

    // Zero-knowledge account-key blobs (plan U8)
    "/api/account": {
      GET: req => capture("/api/account", "GET", req, () => handleGetAccount(req)),
      POST: req => capture("/api/account", "POST", req, () => handleSetupAccount(req)),
    },
    "/api/account/recovery": {
      GET: req => capture("/api/account/recovery", "GET", req, () => handleGetRecoveryBlob(req)),
    },
    "/api/account/rotate": {
      POST: req => capture("/api/account/rotate", "POST", req, () => handleRotateAccount(req)),
    },

    // Durable My History (plan U9) + reconcile import (plan U10)
    "/api/history": {
      GET: req => capture("/api/history", "GET", req, () => handleListHistory(req)),
    },
    "/api/history/:id": {
      DELETE: req =>
        capture("/api/history/:id", "DELETE", req, () => handleDeleteHistory(req, req.params.id)),
      PATCH: req =>
        capture("/api/history/:id", "PATCH", req, () => handleUpdateHistory(req, req.params.id)),
    },
    "/api/reconcile": {
      POST: req => capture("/api/reconcile", "POST", req, () => handleReconcile(req)),
    },

    // Per-box CLI tokens (session-authed mint/list/revoke; CLI plan U2)
    "/api/cli/tokens": {
      GET: req => capture("/api/cli/tokens", "GET", req, () => handleListTokens(req)),
      POST: req => capture("/api/cli/tokens", "POST", req, () => handleMintToken(req)),
    },
    "/api/cli/tokens/:id": {
      DELETE: req =>
        capture("/api/cli/tokens/:id", "DELETE", req, () => handleRevokeToken(req, req.params.id)),
    },

    // Token-authed zero-knowledge upload (Bearer; CLI plan U3) + list (U4)
    "/api/cli/uploads": {
      GET: req =>
        capture("/api/cli/uploads", "GET", req, () =>
          handleCliList(req, getIp(req)),
        ),
      POST: req =>
        capture("/api/cli/uploads", "POST", req, () =>
          handleCliUpload(req, getIp(req)),
        ),
    },
    "/api/cli/uploads/:id": {
      DELETE: req =>
        capture("/api/cli/uploads/:id", "DELETE", req, () =>
          handleCliDelete(req, req.params.id, getIp(req)),
        ),
    },

    "/api/hello": {
      GET: req =>
        capture("/api/hello", "GET", req, () =>
          Response.json({ message: "Hello, world!", method: "GET" }),
        ),
      PUT: req =>
        capture("/api/hello", "PUT", req, () =>
          Response.json({ message: "Hello, world!", method: "PUT" }),
        ),
    },

    "/api/hello/:name": req =>
      capture("/api/hello/:name", req.method, req, () =>
        Response.json({ message: `Hello, ${req.params.name}!` }),
      ),

    // JSON 404 for unmatched API routes. Sits below exact/param routes and
    // above the "/*" SPA catch-all, so /api/... never falls through to HTML.
    // Intentionally bare (uninstrumented): unknown-route 404s are not counted.
    "/api/*": () => Response.json({ error: "not found" }, { status: 404 }),
  };
}

// Start the server only when run as the entry point (`bun src/index.ts`); when
// imported (e.g. by analytics-routes.test.ts) just expose createRoutes, so a
// test can mount the same routes on its own ephemeral-port server.
if (import.meta.main) {
  // Declared before assignment so the IP getter can close over `server` to read
  // the direct client IP (`server.requestIP`) at request time.
  let server: ReturnType<typeof serve>;
  server = serve({
    routes: createRoutes(req => server.requestIP(req)?.address),

    // Tighten well below Bun's 128MB default, but large enough to actually carry
    // a MAX_CIPHERTEXT_BYTES upload: the ciphertext travels base64url-encoded
    // inside the JSON body, which inflates it by 4/3, so a 25MB ciphertext is a
    // ~33.3MB body. Derive the cap from the limit (so the two can't drift) and
    // add 1MB of envelope headroom (id, iv, wrapped key, encrypted title).
    maxRequestBodySize: Math.ceil(MAX_CIPHERTEXT_BYTES / 3) * 4 + 1024 * 1024,

    development: process.env.NODE_ENV !== "production" && {
      // Enable browser hot reloading in development
      hmr: true,

      // Echo console logs from the browser to the server
      console: true,
    },
  });

  console.log(`🚀 Server running at ${server.url}`);
}
