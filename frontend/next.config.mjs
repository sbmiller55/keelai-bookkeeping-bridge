const nextConfig = {
  reactStrictMode: true,

  // Baseline hardening. Deliberately no Content-Security-Policy yet: this app
  // uses inline styles and would need a nonce setup to avoid breaking, so a CSP
  // is a separate, testable change rather than something to bolt on blind.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // The app is never meant to be framed; this blocks clickjacking,
          // where an attacker overlays the real UI to trick a click.
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
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
};

export default nextConfig;
