/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Server-only external packages that should not be bundled for client
  serverExternalPackages: ['better-sqlite3'],
};

module.exports = nextConfig;
