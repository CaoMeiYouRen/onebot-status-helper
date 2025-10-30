import { defineConfig } from 'eslint/config'
import cmyr from 'eslint-config-cmyr'
const __ERROR__ = process.env.NODE_ENV === 'production' ? 2 : 0
export default defineConfig([
    cmyr,
    {
        rules: {
            'no-console': 0,
            'prefer-const': __ERROR__,
        },
    },
    {
        files: ['**/*.{js,cjs,mjs,jsx,ts,tsx,mts,cts}'],
        languageOptions: {
            globals: {
                Bun: true,
            },
        },
    },
    {
        ignores: [
            'dist',
            'node_modules',
            'coverage',
            'build',
            'public',
            '.vercel',
            '.wrangler',
            '.husky',
        ],
    },
])
