import { Response, NextFunction } from 'express';
import { z } from 'zod';
import pg from 'pg';
import { pool, sandboxPool, logSqlExecution, getRecentQueries } from '../config/db.js';
import { AuthRequest } from '../middleware/auth.js';

const executeSqlSchema = z.object({
  query: z.string().min(1).max(5000)
});

/**
 * Validates and sanitizes SQL queries for the interactive sandbox console.
 * Strips comments, collapses whitespace, disallows multi-statement injection,
 * and blocks destructive DDL, user privilege modifications, and credential theft.
 */
export const validateSandboxSql = (rawQuery: string): { allowed: boolean; reason?: string; sanitizedSql: string } => {
  const trimmed = rawQuery.trim();
  if (!trimmed) {
    return { allowed: false, reason: 'Query cannot be empty.', sanitizedSql: '' };
  }

  // Strip single-line comments (-- ...) and multi-line comments (/* ... */)
  const strippedComments = trimmed
    .replace(/--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');

  // Normalize whitespace
  const normalized = strippedComments.replace(/\s+/g, ' ').trim();

  if (!normalized) {
    return { allowed: false, reason: 'Query cannot be empty after stripping comments.', sanitizedSql: '' };
  }

  // Disallow statement chaining: check for internal semicolon not at the very end
  const withoutTrailingSemicolon = normalized.replace(/;+\s*$/, '');
  if (withoutTrailingSemicolon.includes(';')) {
    return {
      allowed: false,
      reason: 'Security Sandbox Violation: Multiple chained statements (semicolons) are blocked.',
      sanitizedSql: normalized
    };
  }

  // Forbidden destructive patterns (case-insensitive regex with word boundaries)
  const forbiddenPatterns: Array<{ regex: RegExp; name: string }> = [
    { regex: /\bDROP\s+(DATABASE|TABLE|SCHEMA|VIEW|MATERIALIZED\s+VIEW|TRIGGER|FUNCTION|PROCEDURE|EXTENSION|INDEX|ROLE|USER)\b/i, name: 'DROP' },
    { regex: /\bTRUNCATE(\s+TABLE)?\b/i, name: 'TRUNCATE' },
    { regex: /\bALTER\s+SYSTEM\b/i, name: 'ALTER SYSTEM' },
    { regex: /\bALTER\s+(USER|ROLE)\b/i, name: 'ALTER USER/ROLE' },
    { regex: /\b(CREATE|DROP)\s+USER\b/i, name: 'CREATE/DROP USER' },
    { regex: /\bGRANT\s+ALL\b/i, name: 'GRANT ALL' },
    { regex: /\bREVOKE\s+ALL\b/i, name: 'REVOKE ALL' },
    { regex: /\b(GRANT|REVOKE)\b/i, name: 'GRANT/REVOKE' },
    { regex: /\bCOPY\s+.*?\s+TO\s+PROGRAM\b/i, name: 'COPY TO PROGRAM' },
    { regex: /\b(pg_shadow|pg_authid)\b/i, name: 'System catalog credentials' },
    { regex: /\bpassword_hash\b/i, name: 'password_hash' }
  ];

  for (const { regex, name } of forbiddenPatterns) {
    if (regex.test(normalized)) {
      return {
        allowed: false,
        reason: `Security Sandbox Violation: '${name}' is blocked in the web console.`,
        sanitizedSql: normalized
      };
    }
  }

  return { allowed: true, sanitizedSql: normalized };
};

export const getSqlHistory = async (req: AuthRequest, res: Response): Promise<void> => {
  res.json({
    success: true,
    data: getRecentQueries()
  });
};

export const executeSqlConsole = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ success: false, error: 'Authentication required' });
      return;
    }

    const { query: rawQuery } = executeSqlSchema.parse(req.body);
    const validation = validateSandboxSql(rawQuery);

    if (!validation.allowed) {
      res.status(403).json({
        success: false,
        error: validation.reason
      });
      return;
    }

    const start = performance.now();
    const queryId = Math.random().toString(36).substring(2, 9);
    const queryToRun = validation.sanitizedSql;

    const client: pg.PoolClient = await pool.connect();

    try {
      // Enforce 3s localized statement timeout; rollback on failure
      await client.query("BEGIN; SET LOCAL statement_timeout = '3000';");
      const result = await client.query(queryToRun);
      await client.query("COMMIT;");
      const durationMs = Number((performance.now() - start).toFixed(2));

      const columns = result.fields ? result.fields.map(f => f.name) : [];
      const rows = result.rows || [];

      // Log to terminal broadcast stream
      logSqlExecution({
        id: queryId,
        sql: queryToRun,
        durationMs,
        rowCount: result.rowCount ?? rows.length,
        status: 'SUCCESS',
        timestamp: new Date().toLocaleTimeString(),
        source: 'INTERACTIVE_CONSOLE'
      });

      res.json({
        success: true,
        columns,
        rows,
        rowCount: result.rowCount ?? rows.length,
        durationMs
      });
    } catch (err: any) {
      try {
        await client.query("ROLLBACK;");
      } catch {
        // Suppress rollback errors
      }

      const durationMs = Number((performance.now() - start).toFixed(2));

      logSqlExecution({
        id: queryId,
        sql: queryToRun,
        durationMs,
        status: 'ERROR',
        error: err.message,
        timestamp: new Date().toLocaleTimeString(),
        source: 'INTERACTIVE_CONSOLE'
      });

      res.status(400).json({
        success: false,
        error: err.message,
        durationMs
      });
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
};

