import logger from '../utils/logger';
import { collectApiKeys } from './apiKeys';

interface EnvValidationResult {
  isValid: boolean;
  missingRequired: string[];
  missingOptional: string[];
}

/**
 * Valida que todas las variables de entorno requeridas estén presentes.
 * Distingue entre variables requeridas y opcionales.
 *
 * Variables requeridas son críticas para la operación del sistema.
 * Variables opcionales permiten funcionalidad adicional pero no son esenciales.
 *
 * @returns Resultado de la validación con listas de variables faltantes
 */
export const validateEnv = (): EnvValidationResult => {
  // Variables requeridas para operación básica del servidor
  const requiredVars = [
    'PORT'
  ];

  // Variables de base de datos (se requiere DB_URL o el conjunto completo de credenciales)
  const dbVars = [
    'DB_HOST',
    'DB_PORT',
    'DB_NAME',
    'DB_USER',
    'DB_PASSWORD'
  ];

  // Variables opcionales que habilitan features adicionales (no bloquean inicio)
  // GEMINI_API_KEY no va acá: el esquema numerado (GEMINI_API_KEY1..N) no se
  // valida mirando un nombre fijo, así que se chequea con el colector más abajo.
  const optionalVars = [
    'LOG_LEVEL',
    'NODE_ENV',
    'CORS_ORIGIN',
    'API_KEY'
  ];

  const missingRequired: string[] = [];
  const missingOptional: string[] = [];

  // Validar variables base requeridas
  for (const varName of requiredVars) {
    const value = process.env[varName];
    if (!value || value.trim() === '') {
      missingRequired.push(varName);
    }
  }

  // Validar conexión a BD: Se requiere DB_URL, DATABASE_URL O todas las variables individuales
  const hasDbUrl = (process.env.DB_URL && process.env.DB_URL.trim() !== '') ||
    (process.env.DATABASE_URL && process.env.DATABASE_URL.trim() !== '');
  const hasAllDbVars = dbVars.every(v => process.env[v] && process.env[v]!.trim() !== '');

  if (!hasDbUrl && !hasAllDbVars) {
    // Si no hay DB_URL ni variables completas, exigir las individuales
    dbVars.forEach(v => {
      if (!process.env[v] || process.env[v]!.trim() === '') {
        missingRequired.push(v);
      }
    });
  }

  // Validar variables opcionales (solo para logging informativo)
  for (const varName of optionalVars) {
    const value = process.env[varName];
    if (!value || value.trim() === '') {
      missingOptional.push(varName);
    }
  }

  // Gemini: cualquiera de GEMINI_API_KEYS, GEMINI_API_KEY o GEMINI_API_KEY1..N
  // alcanza. Se reporta bajo el nombre del esquema vigente para que el warning
  // diga qué escribir, no un nombre que el código ya no busca solo.
  const geminiKeys = collectApiKeys('GEMINI_API_KEY');
  if (geminiKeys.length === 0) {
    missingOptional.push('GEMINI_API_KEY1');
  } else {
    logger.info('Gemini API keys detected', { count: geminiKeys.length });
  }

  // Logging de resultados
  if (missingRequired.length > 0) {
    logger.error('Missing required environment variables', {
      missing: missingRequired
    });
  }

  if (missingOptional.length > 0) {
    logger.warn('Missing optional environment variables', {
      missing: missingOptional
    });
  }

  return {
    isValid: missingRequired.length === 0,
    missingRequired,
    missingOptional
  };
};

/**
 * Valida el entorno y termina el proceso si falta alguna variable requerida.
 * Esta función debe ser llamada al inicio de la aplicación, antes de inicializar
 * servicios que dependen de las variables de entorno.
 *
 * Si todas las variables requeridas están presentes, la función retorna silenciosamente.
 * Si faltan variables requeridas, imprime un error detallado y termina el proceso.
 */
export const validateEnvOrExit = (): void => {
  const result = validateEnv();

  if (!result.isValid) {
    // Imprimir mensaje de error visual en consola
    console.error('\n❌ ENVIRONMENT VALIDATION FAILED\n');
    console.error('Missing required environment variables:');
    result.missingRequired.forEach(varName => {
      console.error(`  - ${varName}`);
    });
    console.error('\nPlease check your .env file and ensure all required variables are set.');
    console.error('See .env.example for reference.\n');

    // Terminar proceso con código de error
    process.exit(1);
  }

  // Si hay variables opcionales faltantes, solo advertir (no bloquear inicio)
  if (result.missingOptional.length > 0) {
    console.warn('\n⚠️  Some optional environment variables are not set:');
    result.missingOptional.forEach(varName => {
      console.warn(`  - ${varName}`);
    });
    console.warn('The application will run with default values.\n');
  }

  // Registrar validación exitosa
  logger.info('Environment validation passed', {
    required: 'all present',
    optional_missing: result.missingOptional.length
  });
};

