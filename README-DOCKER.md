# Running Quotebook in Docker

This image runs the **Next.js frontend**. Convex is a **hosted backend** and is
not containerized — the app talks to your Convex deployment over the network.

> **Important:** `NEXT_PUBLIC_CONVEX_URL` is inlined into the browser bundle at
> **build time**, so it is a Docker **build argument**, not a runtime variable.
> If you change deployments, you must rebuild the image.

## Option A — docker compose (simplest)

```bash
# Uses the dev deployment by default:
docker compose up --build

# Or point at another Convex deployment:
CONVEX_URL=https://your-deployment.convex.cloud docker compose up --build
```

App: http://localhost:3000

## Option B — plain docker

```bash
# Build (bake in the Convex URL):
docker build \
  --build-arg NEXT_PUBLIC_CONVEX_URL=https://veracious-stork-385.convex.cloud \
  -t quotebook .

# Run:
docker run --rm -p 3000:3000 quotebook
```

## Which Convex URL?

- **Dev (this repo manages it):** `https://veracious-stork-385.convex.cloud`
- **Prod:** `https://admired-partridge-220.convex.cloud` — only after the new
  schema + auth code has been deployed there (`npx convex deploy`) and existing
  `requests` rows backfilled with a `userId`.

Use the `.convex.cloud` URL (the WebSocket API), **not** the `.convex.site` URL.

## Notes

- The backend (schema, functions, env vars like `OPENAI_API_KEY`,
  `AGENTMAIL_API_KEY`, `FIRECRAWL_API_KEY`) lives in Convex. Set those with
  `npx convex env set ...` on the deployment, not in this container.
- The image is a multi-stage build using Next.js `output: "standalone"`, runs as
  a non-root user, and listens on port 3000.
- To deploy behind a different port, map it: `-p 8080:3000`.
```
