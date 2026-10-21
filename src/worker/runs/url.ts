// Checks a run's target URL: https, no credentials, and a public host.
// shortcut: checks the literal host only; a public name that resolves to a private address
// passes here, so the sandbox's own egress rules must still block private ranges.
export function checkTargetUrl(
  input: string,
): { url: string } | { error: string } {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { error: "The URL is not valid." };
  }
  if (url.protocol !== "https:") return { error: "The URL must use https." };
  if (url.username || url.password) {
    return { error: "The URL must not contain credentials." };
  }
  if (isPrivateHost(url.hostname)) {
    return { error: "The URL must point to a public host." };
  }
  return { url: url.href };
}

function isPrivateHost(hostname: string): boolean {
  // URL has already normalised hex, octal and short IPv4 forms to dotted decimal.
  if (hostname.startsWith("[")) return isPrivateIPv6(hostname.slice(1, -1));
  const ipv4 = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4) return isPrivateIPv4(ipv4.slice(1).map(Number));
  const name = hostname.replace(/\.$/, "");
  return (
    !name.includes(".") ||
    ["localhost", "local", "internal"].some(
      (suffix) => name === suffix || name.endsWith(`.${suffix}`),
    )
  );
}

function isPrivateIPv4([a = 0, b = 0]: number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

function isPrivateIPv6(address: string): boolean {
  const first = address.split(":")[0] ?? "";
  return (
    // ::, ::1 and IPv4-mapped or -compatible addresses all start with "::".
    address.startsWith("::") ||
    address.startsWith("64:ff9b:") ||
    /^f[cd][0-9a-f]{2}$/.test(first) ||
    /^fe[89ab][0-9a-f]$/.test(first) ||
    /^ff[0-9a-f]{2}$/.test(first)
  );
}
