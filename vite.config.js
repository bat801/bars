import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

const DEFAULT_SUPABASE_URL = 'https://ozcthmspxtrcfxomovoq.supabase.co';

function cspPlugin(supabaseUrl) {
  const supabaseWs = supabaseUrl.replace(/^http/, 'ws');

  return {
    name: 'bars-csp',
    apply: 'build',
    transformIndexHtml(html) {
      const csp = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self'",
        `connect-src 'self' ${supabaseUrl} ${supabaseWs}`,
        "manifest-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        'upgrade-insecure-requests',
      ].join('; ');

      return html.replace(
        '</head>',
        `    <meta http-equiv="Content-Security-Policy" content="${csp}" />\n  </head>`,
      );
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const supabaseUrl = env.VITE_SUPABASE_URL || DEFAULT_SUPABASE_URL;
  const isDev = mode === 'development';

  return {
    // Dev serves from the root, while build and preview use the GitHub Pages
    // sub-path. `command` cannot be used here: Vite reports "serve" for preview.
    base: isDev ? '/' : '/bars/',
    plugins: [cspPlugin(supabaseUrl)],
    build: {
      outDir: 'dist',
      target: 'es2022',
      sourcemap: false,
      // Keep fonts as files: the strict CSP allows font-src 'self' only.
      assetsInlineLimit: 0,
      modulePreload: {
        // Avoid an inline polyfill script so the strict CSP needs no hashes.
        polyfill: false,
      },
    },
    server: {
      host: true,
      port: 5173,
    },
    test: {
      environment: 'node',
      include: ['tests/**/*.test.js'],
    },
  };
});
