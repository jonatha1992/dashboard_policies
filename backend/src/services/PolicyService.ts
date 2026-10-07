import { query, useSQLite, pool, getSQLiteDb } from '../config/database';
import {
  Policy,
  PolicyFilters,
  PaginatedResponse,
  PolicySummary
} from '../types/policy.types';

/**
 * Servicio para operaciones CRUD de pólizas.
 * Este servicio maneja todas las operaciones relacionadas con pólizas de seguros:
 * inserción, consulta, búsqueda y estadísticas agregadas.
 */
export class PolicyService {
  /**
   * Inserta una póliza nueva o actualiza si ya existe (basado en policy_number).
   * Utiliza la cláusula ON CONFLICT de PostgreSQL para lograr idempotencia,
   * permitiendo reintentos seguros sin duplicar datos.
   *
   * Adicionalmente, detecta si la operación fue un INSERT nuevo o un UPDATE
   * de una póliza existente usando el campo interno xmax de PostgreSQL.
   *
   * @param policy - La póliza a insertar o actualizar
   * @returns Objeto con la póliza y un flag indicando si fue actualización
   */
  async insertPolicy(policy: Policy): Promise<{ policy: Policy; was_updated: boolean }> {
    if (useSQLite) {
      // Implementación para SQLite (sin xmax ni RETURNING complejo)

      // 1. Intentar buscar si existe
      const existingKeyCheck = await query(
        'SELECT id FROM policies WHERE policy_number = $1',
        [policy.policy_number]
      );

      if (existingKeyCheck.rowCount > 0) {
        // UPDATE
        await query(
          `UPDATE policies SET
             customer = $1,
             policy_type = $2,
             start_date = $3,
             end_date = $4,
             premium_usd = $5,
             status = $6,
             insured_value_usd = $7,
             operation_id = $8
           WHERE policy_number = $9`,
          [
            policy.customer,
            policy.policy_type,
            policy.start_date,
            policy.end_date,
            policy.premium_usd,
            policy.status,
            policy.insured_value_usd,
            policy.operation_id,
            policy.policy_number
          ]
        );

        const updatedRow = await query('SELECT * FROM policies WHERE policy_number = $1', [policy.policy_number]);
        return { policy: updatedRow.rows[0], was_updated: true };

      } else {
        // INSERT
        await query(
          `INSERT INTO policies
           (policy_number, customer, policy_type, start_date, end_date, premium_usd, status, insured_value_usd, operation_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            policy.policy_number,
            policy.customer,
            policy.policy_type,
            policy.start_date,
            policy.end_date,
            policy.premium_usd,
            policy.status,
            policy.insured_value_usd,
            policy.operation_id
          ]
        );

        const insertedRow = await query('SELECT * FROM policies WHERE policy_number = $1', [policy.policy_number]);
        return { policy: insertedRow.rows[0], was_updated: false };
      }

    } else {
      // Implementación para PostgreSQL (original optimizada)
      // Ejecutar consulta de inserción con manejo de conflictos
      // xmax = 0 indica INSERT, xmax > 0 indica UPDATE (PostgreSQL 9.1+)
      const queryResult = await query(
        `INSERT INTO policies
         (policy_number, customer, policy_type, start_date, end_date, premium_usd, status, insured_value_usd, operation_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (policy_number) DO UPDATE SET
           customer = EXCLUDED.customer,
           policy_type = EXCLUDED.policy_type,
           start_date = EXCLUDED.start_date,
           end_date = EXCLUDED.end_date,
           premium_usd = EXCLUDED.premium_usd,
           status = EXCLUDED.status,
           insured_value_usd = EXCLUDED.insured_value_usd,
           operation_id = EXCLUDED.operation_id
         RETURNING *, (xmax = 0) AS was_insert`,
        [
          policy.policy_number,
          policy.customer,
          policy.policy_type,
          policy.start_date,
          policy.end_date,
          policy.premium_usd,
          policy.status,
          policy.insured_value_usd,
          policy.operation_id // Nuevo campo para trazabilidad
        ]
      );

      const row = queryResult.rows[0];
      const wasInsert = row.was_insert;

      // Eliminar campo técnico antes de retornar
      delete row.was_insert;

      return {
        policy: row,
        was_updated: !wasInsert
      };
    }
  }

  /**
   * Inserta múltiples pólizas en lote (batch).
   * Procesa cada póliza individualmente para asegurar consistencia
   * en caso de errores parciales.
   *
   * @param policies - Array de pólizas a insertar
   * @returns Cantidad total de pólizas insertadas exitosamente
   */
  async insertBatch(policies: Policy[]): Promise<number> {
    const result = await this.insertPoliciesTransaction(policies);
    return result.insertedCount + result.updatedCount;
  }

  /**
   * Inserta o actualiza un lote de pólizas dentro de una transacción atómica.
   * Si ocurre un error, todos los cambios se revierten (rollback).
   */
  async insertPoliciesTransaction(
    policies: Policy[]
  ): Promise<{ insertedCount: number; updatedCount: number; updatedPolicyNumbers: string[] }> {
    let insertedCount = 0;
    let updatedCount = 0;
    const updatedPolicyNumbers: string[] = [];

    if (policies.length === 0) {
      return { insertedCount, updatedCount, updatedPolicyNumbers };
    }

    if (useSQLite) {
      const db = await getSQLiteDb();
      await db.run('BEGIN TRANSACTION');
      try {
        for (const policy of policies) {
          const result = await this.insertPolicy(policy);
          if (result.was_updated) {
            updatedCount++;
            updatedPolicyNumbers.push(policy.policy_number);
          } else {
            insertedCount++;
          }
        }
        await db.run('COMMIT');
      } catch (error) {
        await db.run('ROLLBACK');
        throw error;
      }
    } else {
      if (!pool) throw new Error('Database pool not initialized');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const policy of policies) {
          const queryResult = await client.query(
            `INSERT INTO policies
             (policy_number, customer, policy_type, start_date, end_date, premium_usd, status, insured_value_usd, operation_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (policy_number) DO UPDATE SET
               customer = EXCLUDED.customer,
               policy_type = EXCLUDED.policy_type,
               start_date = EXCLUDED.start_date,
               end_date = EXCLUDED.end_date,
               premium_usd = EXCLUDED.premium_usd,
               status = EXCLUDED.status,
               insured_value_usd = EXCLUDED.insured_value_usd,
               operation_id = EXCLUDED.operation_id
             RETURNING *, (xmax = 0) AS was_insert`,
            [
              policy.policy_number,
              policy.customer,
              policy.policy_type,
              policy.start_date,
              policy.end_date,
              policy.premium_usd,
              policy.status,
              policy.insured_value_usd,
              policy.operation_id
            ]
          );
          const row = queryResult.rows[0];
          const wasInsert = row.was_insert;
          if (!wasInsert) {
            updatedCount++;
            updatedPolicyNumbers.push(policy.policy_number);
          } else {
            insertedCount++;
          }
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }

    return { insertedCount, updatedCount, updatedPolicyNumbers };
  }

  /**
   * Busca pólizas aplicando filtros opcionales y paginación.
   * Construye dinámicamente la consulta SQL basada en los filtros proporcionados.
   *
   * @param filters - Filtros opcionales para refinar la búsqueda
   * @returns Respuesta paginada con las pólizas encontradas y metadatos de paginación
   */
  async findAll(filters: PolicyFilters): Promise<PaginatedResponse<Policy>> {
    // Establecer límites de paginación con valores por defecto y máximos
    const limit = Math.min(filters.limit || 25, 100); // Máximo 100 registros
    const offset = filters.offset || 0;

    // Construir condiciones WHERE dinámicamente
    const whereConditions: string[] = [];
    const parameterValues: unknown[] = [];
    let parameterIndex = 1;

    // Agregar condición de filtro por estado si se especifica
    if (filters.status) {
      whereConditions.push(`status = $${parameterIndex++}`);
      parameterValues.push(filters.status);
    }

    // Agregar condición de filtro por tipo de póliza si se especifica
    if (filters.policy_type) {
      whereConditions.push(`policy_type = $${parameterIndex++}`);
      parameterValues.push(filters.policy_type);
    }

    // Agregar condición de búsqueda por texto si se especifica
    if (filters.q) {
      whereConditions.push(`(policy_number ILIKE $${parameterIndex} OR customer ILIKE $${parameterIndex})`);
      parameterValues.push(`%${filters.q}%`);
      parameterIndex++;
    }

    // Construir cláusula WHERE completa
    const whereClause = whereConditions.length > 0
      ? `WHERE ${whereConditions.join(' AND ')}`
      : '';

    // Obtener el total de registros que coinciden con los filtros
    const countResult = await query(
      `SELECT COUNT(*) as total FROM policies ${whereClause}`,
      parameterValues
    );
    const totalRecords = useSQLite ? (countResult.rows[0] as any).total : parseInt(countResult.rows[0].total);

    // Obtener los registros paginados ordenados por fecha de creación descendente
    const itemsResult = await query(
      `SELECT * FROM policies ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${parameterIndex++} OFFSET $${parameterIndex}`,
      [...parameterValues, limit, offset]
    );

    // Retornar respuesta estructurada con items y metadatos de paginación
    return {
      items: itemsResult.rows,
      pagination: {
        limit,
        offset,
        total: totalRecords
      }
    };
  }

  /**
   * Obtiene estadísticas agregadas del portfolio de pólizas con filtros opcionales.
   * Ejecuta múltiples consultas para calcular totales, conteos por estado
   * y sumas de premium por tipo de póliza, aplicando los filtros especificados.
   *
   * @param filters - Filtros opcionales para limitar el análisis
   * @returns Objeto con estadísticas del portfolio filtrado
   */
  async getSummaryWithFilters(filters?: PolicyFilters): Promise<PolicySummary> {
    // Construir condiciones WHERE dinámicamente (igual que en findAll)
    const whereConditions: string[] = [];
    const parameterValues: unknown[] = [];
    let parameterIndex = 1;

    // Si hay filtros, construir cláusulas WHERE
    if (filters) {
      if (filters.status) {
        whereConditions.push(`status = $${parameterIndex++}`);
        parameterValues.push(filters.status);
      }

      if (filters.policy_type) {
        whereConditions.push(`policy_type = $${parameterIndex++}`);
        parameterValues.push(filters.policy_type);
      }

      if (filters.q) {
        whereConditions.push(`(policy_number ILIKE $${parameterIndex} OR customer ILIKE $${parameterIndex})`);
        parameterValues.push(`%${filters.q}%`);
        parameterIndex++;
      }
    }

    // Construir cláusula WHERE completa
    const whereClause = whereConditions.length > 0
      ? `WHERE ${whereConditions.join(' AND ')}`
      : '';

    // Consulta para obtener totales generales con filtros
    const totalsQuery = await query(`
      SELECT
        COUNT(*)::int as total_policies,
        COALESCE(SUM(premium_usd), 0)::float as total_premium_usd
      FROM policies
      ${whereClause}
    `, parameterValues);

    // Consulta para obtener conteo agrupado por estado con filtros
    const statusQuery = await query(`
      SELECT status, COUNT(*)::int as count
      FROM policies
      ${whereClause}
      GROUP BY status
    `, parameterValues);

    // Consulta para obtener suma de premium agrupada por tipo con filtros
    const typeQuery = await query(`
      SELECT policy_type, COALESCE(SUM(premium_usd), 0)::float as premium
      FROM policies
      ${whereClause}
      GROUP BY policy_type
    `, parameterValues);

    // Construir objeto de respuesta con valores por defecto
    const countByStatus: Record<string, number> = {
      active: 0,
      expired: 0,
      cancelled: 0
    };

    // Llenar los conteos por estado con los resultados de la consulta
    statusQuery.rows.forEach((row: any) => {
      countByStatus[row.status] = useSQLite ? row.count : parseInt(row.count);
    });

    const premiumByType: Record<string, number> = {
      Property: 0,
      Auto: 0,
      Life: 0,
      Health: 0
    };

    // Llenar los premiums por tipo con los resultados de la consulta
    typeQuery.rows.forEach((row: any) => {
      premiumByType[row.policy_type] = useSQLite ? row.premium : parseFloat(row.premium);
    });

    // Retornar el resumen completo
    return {
      total_policies: useSQLite ? (totalsQuery.rows[0] as any).total_policies : parseInt(totalsQuery.rows[0].total_policies),
      total_premium_usd: useSQLite ? (totalsQuery.rows[0] as any).total_premium_usd : parseFloat(totalsQuery.rows[0].total_premium_usd),
      count_by_status: countByStatus,
      premium_by_type: premiumByType
    };
  }

  /**
   * Obtiene estadísticas agregadas del portfolio completo de pólizas.
   * Ejecuta múltiples consultas para calcular totales, conteos por estado
   * y sumas de premium por tipo de póliza.
   *
   * @returns Objeto con estadísticas completas del portfolio
   */
  async getSummary(): Promise<PolicySummary> {
    // Consulta para obtener totales generales
    const totalsQuery = await query(`
      SELECT
        COUNT(*)::int as total_policies,
        COALESCE(SUM(premium_usd), 0)::float as total_premium_usd
      FROM policies
    `);

    // Consulta para obtener conteo agrupado por estado
    const statusQuery = await query(`
      SELECT status, COUNT(*)::int as count
      FROM policies
      GROUP BY status
    `);

    // Consulta para obtener suma de premium agrupada por tipo
    const typeQuery = await query(`
      SELECT policy_type, COALESCE(SUM(premium_usd), 0)::float as premium
      FROM policies
      GROUP BY policy_type
    `);

    // Construir objeto de respuesta con valores por defecto
    const countByStatus: Record<string, number> = {
      active: 0,
      expired: 0,
      cancelled: 0
    };

    // Llenar los conteos por estado con los resultados de la consulta
    statusQuery.rows.forEach((row: any) => {
      countByStatus[row.status] = useSQLite ? row.count : parseInt(row.count);
    });

    const premiumByType: Record<string, number> = {
      Property: 0,
      Auto: 0,
      Life: 0,
      Health: 0
    };

    // Llenar los premiums por tipo con los resultados de la consulta
    typeQuery.rows.forEach((row: any) => {
      premiumByType[row.policy_type] = useSQLite ? row.premium : parseFloat(row.premium);
    });

    // Retornar el resumen completo
    return {
      total_policies: useSQLite ? (totalsQuery.rows[0] as any).total_policies : parseInt(totalsQuery.rows[0].total_policies),
      total_premium_usd: useSQLite ? (totalsQuery.rows[0] as any).total_premium_usd : parseFloat(totalsQuery.rows[0].total_premium_usd),
      count_by_status: countByStatus,
      premium_by_type: premiumByType
    };
  }
}

