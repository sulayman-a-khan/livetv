/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Down-level these deps through SWC to the browserslist target (old smart-TV
  // engines) so their published ESM doesn't ship untranspilable modern syntax.
  transpilePackages: ["hls.js", "lucide-react", "mpegts.js"],
  typescript: {
    // Type errors must fail the build — a build that ignores them ships broken code.
    ignoreBuildErrors: false,
  },
  eslint: {
    // Lint errors must fail the build too.
    ignoreDuringBuilds: false,
  },
  experimental: {
    instrumentationHook: true,
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**",
      },
      {
        protocol: "http",
        hostname: "**",
      },
    ],
    unoptimized: true,
  },
};

module.exports = nextConfig;