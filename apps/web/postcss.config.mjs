/**
 * Tailwind v4 is a single PostCSS plugin and nothing else. No autoprefixer, no postcss-import, and
 * no tailwind.config.ts: the design tokens live in globals.css under `@theme inline`.
 */
const configuration = { plugins: { '@tailwindcss/postcss': {} } };

export default configuration;
