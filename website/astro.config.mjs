import { defineConfig } from 'astro/config';
export default defineConfig({
  site: process.env.SITE_URL || 'https://magicsword-io.github.io',
  base: process.env.SITE_BASE || '/',
  output: 'static',
  trailingSlash: 'always',
  devToolbar: { enabled: false },
});
