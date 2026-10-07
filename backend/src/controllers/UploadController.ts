import { Request, Response } from 'express';
import { parse } from 'csv-parse/sync';
import { ValidationService } from '../services/ValidationService';
import { PolicyService } from '../services/PolicyService';
import { OperationService } from '../services/OperationService';
import { RuleEngine } from '../rules';
import { PolicyInput, UploadResult } from '../types/policy.types';
import { createContextLogger } from '../utils/logger';

/**
 * Controlador para el endpoint POST /upload.
 * Este controlador orquesta el flujo completo de carga de pólizas desde un archivo CSV:
 * parseo del CSV, validaciones técnicas, validaciones de negocio y persistencia en base de datos.
 */
export class UploadController {
  // Servicios utilizados para diferentes aspectos del procesamiento
  private validationService = new ValidationService();
  private policyService = new PolicyService();
  private operationService = new OperationService();
  private ruleEngine = new RuleEngine();

  /**
   * Procesa la carga de un archivo CSV de pólizas.
   *
   * Flujo completo del procesamiento:
   * 1. Crear una operación con estado RECEIVED para trazabilidad
   * 2. Parsear el contenido del archivo CSV
   * 3. Para cada fila del CSV:
   *    - Realizar validaciones técnicas (formato y estructura)
   *    - Si pasa las validaciones técnicas, convertir a objeto Policy
   *    - Realizar validaciones de negocio usando el motor de reglas OOP
   *    - Si pasa todas las validaciones, agregar a la lista de pólizas válidas
   * 4. Insertar todas las pólizas válidas en la base de datos
   * 5. Actualizar la operación con el resultado final
   * 6. Retornar respuesta con métricas y errores encontrados
   *
   * @param req - Objeto Request de Express con el archivo CSV
   * @param res - Objeto Response de Express para enviar la respuesta
   */
  async upload(req: Request, res: Response): Promise<void> {
    // Registrar el tiempo de inicio para calcular duración
    const startTime = Date.now();
    const correlationId = req.correlationId;
    const log = createContextLogger({ correlation_id: correlationId, endpoint: '/upload' });

    // 1. Crear operación para trazabilidad y logging
    const operation = await this.operationService.createOperation('/upload', correlationId);
    log.info('Operation created', { operation_id: operation.id });

    try {
      // 2. Actualizar el estado de la operación a PROCESSING
      await this.operationService.updateOperation(operation.id, { status: 'PROCESSING' });

      // 3. Verificar que se recibió un archivo
      if (!req.file) {
        throw new Error('No file uploaded. Please send a CSV file.');
      }

      // 4. Parsear el contenido del archivo CSV
      const csvContent = req.file.buffer.toString('utf-8');
      let records: PolicyInput[];

      try {
        records = parse(csvContent, {
          columns: true,           // Usar la primera fila como nombres de columnas
          skip_empty_lines: true,  // Ignorar líneas vacías
          trim: true               // Eliminar espacios en blanco
        });
      } catch (parseError: unknown) {
        const errorMessage = parseError instanceof Error ? parseError.message : 'Unknown parse error';
        throw new Error(`Failed to parse CSV: ${errorMessage}`);
      }

      log.info('CSV parsed', { total_rows: records.length });

      // 5. Inicializar estructuras para almacenar resultados del procesamiento
      const allErrors: Array<{ row_number: number; field: string; code: string; message?: string }> = [];
      const validPolicies: Array<{ policy: ReturnType<ValidationService['parseToPolicy']>; rowNumber: number }> = [];

      // 6. Procesar cada fila del CSV
      for (let i = 0; i < records.length; i++) {
        const rowNumber = i + 1; // Las filas empiezan en 1 (después del header)
        const record = records[i];

        // Paso 6.1: Realizar validaciones técnicas (formato y estructura)
        const technicalErrors = this.validationService.validateTechnical(record, rowNumber);
        if (technicalErrors.length > 0) {
          allErrors.push(...technicalErrors);
          continue; // Saltar al siguiente registro si hay errores técnicos
        }

        // Paso 6.2: Convertir el registro a un objeto Policy tipado
        const policy = this.validationService.parseToPolicy(record);

        // Paso 6.3: Realizar validaciones de negocio usando el motor de reglas OOP
        const businessErrors = this.ruleEngine.validate(policy, rowNumber);
        if (businessErrors.length > 0) {
          allErrors.push(...businessErrors);
          continue; // Saltar al siguiente registro si hay errores de negocio
        }

        // Paso 6.4: Si pasa todas las validaciones, agregar a la lista de pólizas válidas
        validPolicies.push({ policy, rowNumber });
      }

      // 7. Insertar todas las pólizas válidas en la base de datos de manera atómica
      for (const { policy } of validPolicies) {
        policy.operation_id = operation.id;
      }

      const { insertedCount, updatedCount, updatedPolicyNumbers } =
        await this.policyService.insertPoliciesTransaction(validPolicies.map(v => v.policy));

      // 8. Calcular la duración total del procesamiento
      const duration = Date.now() - startTime;

      // 9. Actualizar la operación con el resultado final
      await this.operationService.updateOperation(operation.id, {
        status: 'COMPLETED',
        rows_inserted: insertedCount,
        rows_updated: updatedCount,
        rows_rejected: allErrors.length,
        duration_ms: duration,
        error_summary: allErrors.length > 0 ? JSON.stringify(allErrors.slice(0, 50)) : null
      });

      // 10. Construir la respuesta para el cliente
      const rejectedCount = records.length - insertedCount - updatedCount;
      const result: UploadResult = {
        operation_id: operation.id,
        correlation_id: correlationId,
        inserted_count: insertedCount,
        updated_count: updatedCount,
        rejected_count: rejectedCount,
        errors: allErrors,
        updated_policies: updatedPolicyNumbers
      };

      log.info('Upload completed', {
        operation_id: operation.id,
        inserted: insertedCount,
        updated: updatedCount,
        rejected: rejectedCount,
        duration_ms: duration
      });

      // 11. Determinar el código HTTP apropiado según el resultado
      let statusCode: number;

      if (rejectedCount === 0) {
        // CASO 1: Todas las filas procesadas exitosamente
        statusCode = 200; // OK
      } else if (rejectedCount === records.length) {
        // CASO 2: Todas las filas rechazadas por validación
        statusCode = 422; // Unprocessable Entity
      } else {
        // CASO 3: Procesamiento parcial (algunas OK, otras rechazadas)
        statusCode = 207; // Multi-Status
      }

      // Enviar respuesta al cliente con código HTTP apropiado
      res.status(statusCode).json(result);
    } catch (error: unknown) {
      // 12. Manejo de errores: calcular duración y actualizar operación como fallida
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // Actualizar operación como fallida
      await this.operationService.updateOperation(operation.id, {
        status: 'FAILED',
        duration_ms: duration,
        error_summary: errorMessage
      });

      log.error('Upload failed', { error: errorMessage, operation_id: operation.id });

      // Enviar respuesta de error al cliente
      res.status(500).json({
        operation_id: operation.id,
        correlation_id: correlationId,
        error: errorMessage
      });
    }
  }
}

