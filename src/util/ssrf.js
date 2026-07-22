// Validate that a URL is safe to fetch — blocks private/internal IPs,
// link-local addresses, and cloud metadata endpoints to prevent SSRF.
//
// Every outbound fetch driven by model output (fetch_page, vision image
// downloads) passes through here, and redirect targets are re-checked because
// the first hop being public says nothing about where it points.

function isSafeUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { safe: false, reason: "Invalid URL format." };
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { safe: false, reason: `Unsupported protocol: ${parsed.protocol}` };
  }

  const hostname = parsed.hostname.toLowerCase();

  if (hostname === "169.254.169.254" || hostname === "metadata.google.internal" || hostname === "metadata.azure.com") {
    return { safe: false, reason: "Cloud metadata endpoints are not allowed." };
  }

  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "0.0.0.0") {
    return { safe: false, reason: "Localhost addresses are not allowed." };
  }

  if (/\.(local|internal|localhost)$/i.test(hostname)) {
    return { safe: false, reason: "Internal hostnames are not allowed." };
  }

  const ipRegex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const match = hostname.match(ipRegex);
  if (match) {
    const [, a, b, c] = match.map(Number);
    if (a === 10) return { safe: false, reason: "Private IP addresses are not allowed." };
    if (a === 172 && b >= 16 && b <= 31) return { safe: false, reason: "Private IP addresses are not allowed." };
    if (a === 192 && b === 168) return { safe: false, reason: "Private IP addresses are not allowed." };
    if (a === 169 && b === 254) return { safe: false, reason: "Link-local addresses are not allowed." };
    if (a === 127) return { safe: false, reason: "Loopback addresses are not allowed." };
    if (a === 0) return { safe: false, reason: "Unspecified addresses are not allowed." };
    if (a === 100 && b >= 64 && b <= 127) return { safe: false, reason: "Carrier-grade NAT addresses are not allowed." };
    // Documentation / reserved ranges (RFC 5737).
    if (a === 192 && b === 0 && c === 2) return { safe: false, reason: "Documentation/reserved addresses are not allowed." };
    if (a === 198 && b === 51 && c === 100) return { safe: false, reason: "Documentation/reserved addresses are not allowed." };
    if (a === 203 && b === 0 && c === 113) return { safe: false, reason: "Documentation/reserved addresses are not allowed." };
    // Benchmarking (198.18/15) and multicast/reserved space.
    if (a === 198 && (b === 18 || b === 19)) return { safe: false, reason: "Benchmarking addresses are not allowed." };
    if (a >= 224) return { safe: false, reason: "Multicast/reserved addresses are not allowed." };
  }

  // Bracketed IPv6 literals: block loopback, link-local (fe80::/10), and
  // unique-local (fc00::/7). The URL parser strips the brackets already.
  if (hostname.includes(":")) {
    const v6 = hostname.replace(/^\[|\]$/g, "");
    if (v6 === "::" || v6 === "::1") return { safe: false, reason: "Loopback addresses are not allowed." };
    if (/^fe[89ab]/i.test(v6)) return { safe: false, reason: "Link-local addresses are not allowed." };
    if (/^f[cd]/i.test(v6)) return { safe: false, reason: "Unique-local addresses are not allowed." };
  }

  return { safe: true };
}

module.exports = { isSafeUrl };
