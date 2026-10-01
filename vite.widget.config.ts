import { defineConfig } from 'vite-plus';

/**
 * Embeddable loader: one minified IIFE (`public/widget/v1/loader.js`), no exports and no globals other than
 * what the code installs itself (`window.ChatFeature`). Built with `npm run build:widget`; kept out of the
 * main app build so the app's chunking, React and Tailwind never touch it.
 */
export default defineConfig({
    publicDir: false,
    build: {
        outDir: 'public/widget/v1',
        emptyOutDir: true,
        target: 'es2020',
        cssTarget: 'esnext',
        sourcemap: false,
        minify: true,
        reportCompressedSize: true,
        rollupOptions: {
            input: 'resources/widget/src/index.ts',
            output: {
                format: 'iife',
                entryFileNames: 'loader.js',
            },
        },
    },
});
