/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Produces .next/standalone with a minimal server + only the deps it needs,
  // so the Docker runtime image can skip node_modules entirely.
  output: "standalone",
};

export default nextConfig;
