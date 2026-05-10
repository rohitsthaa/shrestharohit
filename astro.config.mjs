// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  site: 'https://shrestharohit.com.np',
  // Only use base path in production (GitHub Pages)
  base: process.env.NODE_ENV === 'production' ? '/' : '/',
  cacheDir: '.astro/cache',
  integrations: [sitemap()],
  vite: {
    cacheDir: '.vite-cache',
  },
  markdown: {
    shikiConfig: {
      theme: 'css-variables',
      langs: [],
      wrap: true,
    },
  },
});
