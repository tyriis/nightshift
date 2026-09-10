import adapter from '@sveltejs/adapter-static'
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    // D-vv: the SPA shell is served by fastify under /ui; the static fallback answers
    // deep-links. precompress pairs @fastify/static preCompressed:true.
    paths: { base: '/ui' },
    adapter: adapter({
      pages: 'build',
      assets: 'build',
      fallback: 'index.html',
      precompress: true,
      strict: true,
    }),
  },
}

export default config
