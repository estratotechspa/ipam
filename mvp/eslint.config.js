// ESLint (configuración «flat»). Reglas de calidad + seguridad que se verifican en CI y en el pre-commit.
const js = require('@eslint/js');
const globals = require('globals');

// Consultas SQL: solo parametrizadas ($1, $2…). Un texto armado con datos (plantillas con variables o concatenación) puede inyectar SQL.
// Se permiten, dentro de una consulta, solo constantes del módulo en MAYÚSCULAS (fragmentos fijos como RESERVA_VIGENTE).
const LLAMADA_SQL = ':matches(CallExpression[callee.property.name=/^(query|consultar)$/], CallExpression[callee.name="q"])';
const reglaSql = [
  {
    selector: `${LLAMADA_SQL} > TemplateLiteral > :not(TemplateElement):not(Identifier[name=/^[A-Z][A-Z0-9_]*$/])`,
    message: 'SQL con texto interpolado: usa parámetros ($1, $2…). Solo se permiten constantes en MAYÚSCULAS del módulo.',
  },
  { selector: `${LLAMADA_SQL}[arguments.0.type="BinaryExpression"]`, message: 'SQL armado concatenando texto: usa parámetros ($1, $2…).' },
  {
    selector: `${LLAMADA_SQL}[arguments.0.callee.property.name=/^(concat|replace|replaceAll|join)$/]`,
    message: 'SQL armado con concat/replace/join: usa parámetros ($1, $2…).',
  },
];

module.exports = [
  { ignores: ['node_modules/**', 'coverage/**', 'test-results/**', 'playwright-report/**', 'chart/**', 'e2e/**/*.png'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: { ...globals.node, ...globals.nodeBuiltin } },
    rules: {
      // Calidad: límites razonables de complejidad y tamaño; nada de código muerto.
      complexity: ['error', 25],
      'max-depth': ['error', 5],
      'max-params': ['error', 7],
      'max-lines-per-function': ['error', { max: 160, skipBlankLines: true, skipComments: true }],
      'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-unreachable': 'error',
      'no-unused-private-class-members': 'error',
      'no-useless-return': 'error',
      'no-useless-catch': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'error',
      // Seguridad.
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-script-url': 'error',
      'no-restricted-syntax': ['error', ...reglaSql],
      'no-restricted-properties': [
        'error',
        { object: 'process', property: 'env', message: 'Lee la configuración desde src/config.js (nadie más toca process.env).' },
      ],
      'no-console': 'error', // los logs van por el logger JSON (redacta credenciales)
    },
  },
  // La configuración es el único lugar que lee process.env; las pruebas y sus ayudantes preparan el entorno.
  {
    files: ['src/config.js', 'src/**/*.test.js', 'src/pruebas/**', 'e2e/**', 'playwright.config.js', 'eslint.config.js', '**/*.test.js'],
    rules: { 'no-restricted-properties': 'off' },
  },
  {
    files: ['src/**/*.test.js', 'src/pruebas/**', 'e2e/**', 'scripts/**', 'src/cli/**', 'playwright.config.js'],
    rules: { 'no-console': 'off', 'max-lines-per-function': 'off', complexity: 'off' },
  },
  // El repositorio en memoria es un doble de pruebas (un objeto con todos los métodos del puerto): su largo es el del puerto.
  { files: ['src/adaptadores/persistencia/memoria/**'], rules: { 'max-lines-per-function': 'off' } },
  // Las pruebas de navegador ejecutan código dentro de la página (page.evaluate).
  { files: ['e2e/**/*.js'], languageOptions: { globals: { ...globals.browser } } },
  // La interfaz web corre en el navegador.
  {
    files: ['public/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser } },
    rules: {
      'no-restricted-properties': 'off',
      'no-console': 'off',
      'no-unused-vars': ['error', { args: 'none', varsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
];
