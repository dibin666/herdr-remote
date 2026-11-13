export default {
  plugins: {
    // Absolute path: vitest resolves PostCSS plugins from the repo root, where
    // a bare config lookup misses this file and Tailwind warns about empty
    // content.
    tailwindcss: {
      config: new URL('./tailwind.config.js', import.meta.url).pathname,
    },
    autoprefixer: {},
  },
};
