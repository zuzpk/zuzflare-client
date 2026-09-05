/**
 * Browser Fingerprint Generation
 * Generates a unique fingerprint for device binding to prevent cookie hijacking
 */

export interface BrowserFingerprint {
  userAgent: string;
  screen: string;
  timezone: string;
  language: string;
  canvas?: string;
  webgl?: string;
}

/**
 * Generate a browser fingerprint for device binding
 * @returns SHA-256 hash of browser components, formatted as "sha256:<hash>"
 */
export async function generateBrowserFingerprint(): Promise<string> {
  // Server-side: no fingerprint
  if (typeof window === 'undefined') {
    return '';
  }

  const components: BrowserFingerprint = {
    userAgent: navigator.userAgent,
    screen: `${screen.width}x${screen.height}x${screen.colorDepth}`,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    language: navigator.language,
  };

  // Optional: Canvas fingerprint (more unique but slower)
  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.textBaseline = 'top';
      ctx.font = '14px Arial';
      ctx.fillText('fingerprint', 2, 2);
      components.canvas = canvas.toDataURL().slice(0, 100);
    }
  } catch {
    // Canvas not available or blocked
  }

  // Optional: WebGL fingerprint
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl');
    if (gl) {
      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      if (debugInfo) {
        components.webgl = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
      }
    }
  } catch {
    // WebGL not available
  }

  // Hash the fingerprint using SHA-256
  const fingerprintStr = JSON.stringify(components);
  
  // Use SubtleCrypto if available (modern browsers)
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    try {
      const hash = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(fingerprintStr)
      );
      const hashArray = Array.from(new Uint8Array(hash));
      const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
      return `sha256:${hashHex}`;
    } catch {
      // Fall back to simple hash
    }
  }

  // Fallback: Simple hash for older browsers
  let hash = 0;
  for (let i = 0; i < fingerprintStr.length; i++) {
    const char = fingerprintStr.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  const hashHex = Math.abs(hash).toString(16).padStart(8, '0');
  return `simple:${hashHex}`;
}

/**
 * Generate a lightweight fingerprint (faster, less unique)
 * Use this when performance is critical
 */
export function generateLightweightFingerprint(): string {
  if (typeof window === 'undefined') {
    return '';
  }

  const components = [
    navigator.userAgent,
    `${screen.width}x${screen.height}`,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    navigator.language,
  ].join('|');

  // Simple hash
  let hash = 0;
  for (let i = 0; i < components.length; i++) {
    const char = components.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }

  return `lw:${Math.abs(hash).toString(16)}`;
}
