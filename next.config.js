/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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