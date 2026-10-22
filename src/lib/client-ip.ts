/**
 * The client IP behind reverse proxies. Each proxy appends the address it received the request
 * from to X-Forwarded-For, so only the last `hops` entries were written by proxies we run; anything
 * to their left was sent by the client and can be forged. With hops = N the client IP is the N-th
 * entry from the right.
 *
 * VIGIL_TRUSTED_PROXY_HOPS (default 1): Vercel, or one nginx/Caddy in front. Set 2 for a CDN plus
 * a load balancer. Set 0 when VIGIL is reached directly: X-Forwarded-For is then ignored and only
 * X-Real-IP (set by your server) is used.
 */
export function clientIp(forwardedFor: string | null, realIp: string | null, hops = trustedHops()): string | null {
  if (hops > 0 && forwardedFor) {
    const chain = forwardedFor
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    const ip = chain[Math.max(0, chain.length - hops)];
    if (ip) return ip.slice(0, 64);
  }
  return realIp?.trim().slice(0, 64) || null;
}

export function trustedHops(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.VIGIL_TRUSTED_PROXY_HOPS ?? 1);
  return Number.isInteger(n) && n >= 0 && n <= 10 ? n : 1;
}
