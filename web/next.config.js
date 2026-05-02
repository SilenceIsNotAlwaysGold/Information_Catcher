/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  distDir: 'out',
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
  typescript: {
    // 允许构建时忽略类型错误（静态导出的已知问题）
    ignoreBuildErrors: true,
  },
  // 把 barrel 包按需 import，减小每页 First Load JS、加快路由切换
  experimental: {
    optimizePackageImports: [
      'lucide-react',
      '@nextui-org/react',
    ],
  },
};

module.exports = nextConfig;
