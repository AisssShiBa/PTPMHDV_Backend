import globals from 'globals'
import tseslint from 'typescript-eslint'
import { defineConfig } from 'eslint/config'

export default defineConfig([
  {
    files: ['**/*.{js,mjs,cjs,ts,mts,cts}'],

    languageOptions: {
      globals: globals.node
    },

    rules: {
      'no-console': 'off',
      'no-lonely-if': 'warn',
      'no-unused-vars': 'warn',
      'no-trailing-spaces': 'warn',
      'no-multi-spaces': 'warn',
      'no-multiple-empty-lines': 'warn',
      'space-before-blocks': ['error', 'always'],
      'object-curly-spacing': ['warn', 'always'],
      indent: ['warn', 2],
      semi: ['warn', 'never'],
      quotes: ['error', 'single'],
      'array-bracket-spacing': 'warn',
      'linebreak-style': 'off',
      'no-unexpected-multiline': 'warn',
      'keyword-spacing': 'warn',
      'comma-dangle': 'warn',
      'comma-spacing': 'warn',
      'arrow-spacing': 'warn'
    }
  },

  tseslint.configs.recommended
])
