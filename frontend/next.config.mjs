const API_ORIGIN =
  process.env.NEXT_PUBLIC_API_URL || "https://backend-production-75be.up.railway.app";

// Content-Security-Policy.
//
// 'unsafe-inline' is present for scripts and styles because Next.js inlines its
// hydration bootstrap and Tailwind emits inline style attributes; removing it
// needs per-request nonces, which is a separate change worth testing on its own
// rather than bolting on here. What this policy does buy, even with inline
// allowed, is that an injected <script src="https://evil/x.js"> won't load, the
// page can't be framed, plugins are blocked, and — the one that matters most
// for an app holding bank data — connect-src pins network calls to this origin
// and the API, so injected code cannot quietly POST the books somewhere else.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self' ${API_ORIGIN}`,
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "upgrade-insecure-requests",
].join("; ");

const nextConfig = {
  reactStrictMode: true,

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: CSP },
          // Kept alongside the CSP's frame-ancestors for older browsers that
          // understand only this one.
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
        ],
      },
    ];
  },

  // Send plain HTTP to HTTPS. Railway and Cloudflare terminate TLS upstream, so
  // the original scheme only survives in x-forwarded-proto. The condition
  // matches solely when that header is explicitly "http": if it is absent or
  // already https, nothing matches and no redirect happens, which is what keeps
  // this from looping.
  async redirects() {
    return [
      {
        source: "/:path*",
        has: [{ type: "header", key: "x-forwarded-proto", value: "http" }],
        destination: "https://app.keelai.co/:path*",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
