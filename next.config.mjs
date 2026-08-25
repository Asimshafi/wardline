/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // We use no next/image. Disabling the optimizer closes the /_next/image endpoint
  // entirely, neutralizing the Image Optimization DoS advisory (GHSA-h64f-5h5j-jqjh).
  images: { unoptimized: true },
};

export default nextConfig;
