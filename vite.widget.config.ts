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
                // Recognisable on the wire (`GET /widget/v1/loader.js`): the dashboard's "is the bundle built?"
                // probe looks for this marker, which the server's "bundle not built" stub does not contain.
                // `postBanner` is added after minification, so the comment survives.
                postBanner: '/*! pne-chat-loader v1 */',
                intro: '"use strict";',
            },
        },
    },
});
