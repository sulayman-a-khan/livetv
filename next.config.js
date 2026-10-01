/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Down-level these deps through SWC to the browserslist target (old smart-TV
  // engines) so their published ESM doesn't ship untranspilable modern syntax.
  transpilePackages: ["hls.js", "lucide-react", "mpegts.js"],
  typescript: {
    // Vercel build-এর সময় টাইপস্ক্রিপ্ট এরর বাইপাস করবে
    ignoreBuildErrors: true,
  },
  eslint: {
    // Build-এর সময় ESLint এরর বাইপাস করবে
    ignoreDuringBuilds: true,
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