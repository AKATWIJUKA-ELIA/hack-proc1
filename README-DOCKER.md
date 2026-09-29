# Running Quotebook in Docker

This image runs the **Next.js frontend only**. Convex is the **hosted backend**
(Convex Cloud) and is not containerized — the app talks to it over the network.

The Dockerfile **clones the public repo itself**, so anyone can build it with just
Docker installed — no local source checkout required.

## Run it (zero config)

```bash
docker build -t quotebook .
docker run --rm -p 3000:3000 quotebook
```

App: http://localhost:3000

## Overrides (optional)

All are `--build-arg`s because `NEXT_PUBLIC_CONVEX_URL` is inlined into the client
bundle at **build time** (change it → rebuild).

```bash
docker build \
  --build-arg NEXT_PUBLIC_CONVEX_URL=https://your-deployment.convex.cloud \
  --build-arg REPO_URL=https://github.com/you/your-fork.git \
  --build-arg REPO_REF=your-branch \
  -t quotebook .
```

## Notes

- **Push before you build.** The image builds from what's on GitHub
  (`REPO_URL`/`REPO_REF`), not your local working tree — commit and push first.
- Use the `.convex.cloud` URL (the API), **not** `.convex.site`.
- Convex deployments:
  - Dev (this repo manages it): `https://veracious-stork-385.convex.cloud`
  - Prod: `https://admired-partridge-220.convex.cloud` (deploy the new schema +
    auth there first, and backfill `requests.userId`, before pointing at it).
- Backend secrets (`OPENAI_API_KEY`, `AGENTMAIL_API_KEY`, `FIRECRAWL_API_KEY`)
  live in Convex (`npx convex env set ...`), not in this container.
