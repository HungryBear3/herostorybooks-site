export function browserRandomHex(byteLength = 16): string {
  const bytes = new Uint8Array(byteLength);
  try {
    if (typeof globalThis.crypto?.getRandomValues === "function") {
      globalThis.crypto.getRandomValues(bytes);
      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    }
  } catch {
    // Restricted in-app WebViews can expose `crypto` while refusing its methods.
  }

  // Browser IDs are retry nonces, not authentication or payment authority. The
  // server still validates the complete immutable checkout contract. Mix time
  // into a full-length PRNG fallback so legacy/restricted WebViews can submit
  // without collapsing every buyer onto one deterministic order ID.
  const now = Date.now();
  for (let index = 0; index < bytes.length; index += 1) {
    const timeByte = Math.floor(now / (2 ** ((index % 6) * 8))) & 0xff;
    bytes[index] = Math.floor(Math.random() * 256) ^ timeByte;
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
