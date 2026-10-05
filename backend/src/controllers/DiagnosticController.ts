import { Request, Response } from 'express';
import { checkConnection } from '../config/database';
import { validateEnv } from '../config/validateEnv';
import { collectApiKeys } from '../config/apiKeys';
import logger from '../utils/logger';

interface DiagnosticResult {
  status: 'healthy' | 'degraded' | 'error';
  timestamp: string;
  checks: {
    environment: {
      status: 'ok' | 'warning' | 'error';
      missing_required: string[];
      missing_optional: string[];
    };
    database: {
      status: 'ok' | 'error';
      connected: boolean;
      error?: string;
      version?: string;
    };
    runtime: {
      node_version: string;
      platform: string;
      uptime_seconds: number;
      memory_usage_mb: {
        used: number;
        total: number;
      };
    };
    services: {
      ai_enabled: boolean;
      gemini_configured: boolean;
    };
  };
}

/**
 * Controlador para el endpoint de diagnóstico del sistema.
 * Proporciona una visión completa del estado de salud de la aplicación,
 * incluyendo variables de entorno, conexión a base de datos, y servicios.
 */
export class DiagnosticController {
  /**
   * Endpoint GET /config/validate
   * Realiza una verificación completa del sistema y retorna el estado de todos los componentes.
   *
   * @param req - Request de Express con correlation_id
   * @param res - Response de Express para enviar el resultado del diagnóstico
   */
  async validate(req: Request, res: Response): Promise<void> {
    const log = logger.child({ correlation_id: req.correlationId });

    try {
      const result: DiagnosticResult = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        checks: {
          environment: { status: 'ok', missing_required: [], missing_optional: [] },
          database: { status: 'ok', connected: false },
          runtime: {
            node_version: process.version,
            platform: process.platform,
            uptime_seconds: Math.floor(process.uptime()),
            memory_usage_mb: {
              used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
              total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
            }
          },
          services: {
            ai_enabled: false,
            gemini_configured: false
          }
        }
      };

      // CHECK 1: Validar variables de entorno
      const envValidation = validateEnv();
      result.checks.environment.missing_required = envValidation.missingRequired;
      result.checks.environment.missing_optional = envValidation.missingOptional;

      if (envValidation.missingRequired.length > 0) {
        result.checks.environment.status = 'error';
        result.status = 'error';
      } else if (envValidation.missingOptional.length > 0) {
        result.checks.environment.status = 'warning';
        if (result.status === 'healthy') result.status = 'degraded';
      }

      // CHECK 2: Verificar conexión a base de datos
      try {
        const dbStatus = await checkConnection();
        result.checks.database.connected = dbStatus.connected;

        if (dbStatus.connected) {
          result.checks.database.status = 'ok';
          result.checks.database.version = dbStatus.version;
        } else {
          result.checks.database.status = 'error';
          result.checks.database.error = dbStatus.error;
          result.status = 'error';
        }
      } catch (dbError) {
        result.checks.database.connected = false;
        result.checks.database.status = 'error';
        result.checks.database.error = dbError instanceof Error ? dbError.message : 'Unknown error';
        result.status = 'error';
      }

      // CHECK 3: Verificar servicios opcionales
      // Se usa el colector, no un nombre fijo: leer sólo GEMINI_API_KEY hacía que
      // el diagnóstico reportara "sin IA" con siete keys numeradas cargadas.
      const geminiKeys = collectApiKeys('GEMINI_API_KEY');
      if (geminiKeys.length > 0) {
        result.checks.services.gemini_configured = true;
        result.checks.services.ai_enabled = true;
      }

      // Determinar código de estado HTTP
      const statusCode = result.status === 'error' ? 503 : 200;

      log.info('Diagnostic check completed', { status: result.status });

      res.status(statusCode).json(result);
    } catch (error) {
      log.error('Diagnostic check failed', { error });
      res.status(500).json({
        status: 'error',
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
}

