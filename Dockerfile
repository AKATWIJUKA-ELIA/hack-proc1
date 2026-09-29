# Quotebook — Next.js frontend, built by cloning the repo (Convex is the hosted
# backend; this image only runs the frontend and talks to Convex Cloud over HTTP).
#

FROM node:22-slim

# git, to clone the project into the image.
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# Clone the repo. Override with --build-arg to build a fork or a branch.
ARG REPO_URL=https://github.com/AKATWIJUKA-ELIA/hack-proc1.git
ARG REPO_REF=trunk
RUN git clone --depth 1 --branch ${REPO_REF} ${REPO_URL} /app
WORKDIR /app

# The Convex Cloud backend URL. Inlined into the client bundle at build time
# (NEXT_PUBLIC_*), so it must be set before `npm run build`. Defaults to the live
# deployment so this image builds and runs with no flags.
ARG NEXT_PUBLIC_CONVEX_URL=https://veracious-stork-385.convex.cloud
ENV NEXT_PUBLIC_CONVEX_URL=${NEXT_PUBLIC_CONVEX_URL}

# Install dependencies and build the production bundle.
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm ci
RUN npm run build

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
EXPOSE 3000

# Serve the built Next.js app on the default port.
CMD ["npm", "run", "start", "--", "-p", "3000", "-H", "0.0.0.0"]
