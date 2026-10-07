import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import logger from '../utils/logger';

/**
 * Middleware para validar el header x-api-key.
 * Compara el key enviado por el cliente con el configurado en el servidor (API_KEY)
 * utilizando comparación en tiempo constante para mitigar timing attacks.
 */
export const apiKeyMiddleware = (req: Request, res: Response, next: NextFunction) => {
    // Eximir endpoints públicos (salud y documentación)
    const publicPaths = ['/health', '/api-docs'];
    if (publicPaths.some(path => req.path.startsWith(path))) {
        return next();
    }

    const apiKey = req.headers['x-api-key'];
    const configuredApiKey = process.env.API_KEY;

    // Si no hay key configurado en el servidor en producción, fallar de manera segura
    if (!configuredApiKey) {
        if (process.env.NODE_ENV === 'production') {
            logger.error('CRITICAL: API_KEY is not configured on the server in production environment');
            return res.status(500).json({
                error: 'Server security configuration error. API_KEY must be configured in production.',
                correlation_id: req.correlationId
            });
        }
        logger.warn('API_KEY not configured in development environment. Allowing request.');
        return next();
    }

    // Validar que el cliente envió el key
    if (!apiKey || typeof apiKey !== 'string') {
        logger.warn('Unauthorized API access attempt: missing x-api-key header', {
            path: req.path,
            method: req.method,
            correlation_id: req.correlationId
        });

        return res.status(401).json({
            error: 'Unauthorized access. Valid API key required in x-api-key header.',
            correlation_id: req.correlationId
        });
    }

    // Comparación segura en tiempo constante (timingSafeEqual)
    const apiKeyBuffer = Buffer.from(apiKey);
    const configuredKeyBuffer = Buffer.from(configuredApiKey);

    const isMatch = apiKeyBuffer.length === configuredKeyBuffer.length &&
        crypto.timingSafeEqual(apiKeyBuffer, configuredKeyBuffer);

    if (!isMatch) {
        logger.warn('Unauthorized API access attempt: invalid API key', {
            path: req.path,
            method: req.method,
            correlation_id: req.correlationId
        });

        return res.status(401).json({
            error: 'Unauthorized access. Valid API key required in x-api-key header.',
            correlation_id: req.correlationId
        });
    }

    next();
};
