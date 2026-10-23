import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateSandboxSql } from '../src/controllers/sqlController.js';

describe('SQL Console Sandbox Security Rules Unit Tests', () => {
  it('should allow benign SELECT queries', () => {
    const res = validateSandboxSql('SELECT * FROM charging_station WHERE city = \'Bengaluru\';');
    assert.equal(res.allowed, true);
  });

  it('should allow CTE analytical queries', () => {
    const res = validateSandboxSql('WITH RECURSIVE GridFeederHierarchy AS (SELECT * FROM charging_station) SELECT * FROM GridFeederHierarchy;');
    assert.equal(res.allowed, true);
  });

  it('should block DROP DATABASE attempts', () => {
    const res = validateSandboxSql('DROP DATABASE voltgrid_db;');
    assert.equal(res.allowed, false);
    assert.match(res.reason!, /DROP/);
  });

  it('should block DROP TABLE attempts (case-insensitive)', () => {
    const res = validateSandboxSql('drop table charging_reservation CASCADE;');
    assert.equal(res.allowed, false);
    assert.match(res.reason!, /DROP/);
  });

  it('should block DROP TABLE attempts with comment bypass', () => {
    const res = validateSandboxSql('DROP/**/TABLE charging_reservation CASCADE;');
    assert.equal(res.allowed, false);
    assert.match(res.reason!, /DROP/);
  });

  it('should block TRUNCATE statements', () => {
    const res = validateSandboxSql('TRUNCATE TABLE user_account;');
    assert.equal(res.allowed, false);
    assert.match(res.reason!, /TRUNCATE/);
  });

  it('should block ALTER SYSTEM attempts', () => {
    const res = validateSandboxSql('ALTER SYSTEM SET max_connections = 1000;');
    assert.equal(res.allowed, false);
    assert.match(res.reason!, /ALTER SYSTEM/);
  });

  it('should block privilege escalation commands', () => {
    const res = validateSandboxSql('GRANT ALL PRIVILEGES ON DATABASE voltgrid_db TO public;');
    assert.equal(res.allowed, false);
    assert.match(res.reason!, /GRANT/);
  });

  it('should block multi-statement chaining injections', () => {
    const res = validateSandboxSql('SELECT 1; UPDATE user_account SET first_name = \'hacked\';');
    assert.equal(res.allowed, false);
    assert.match(res.reason!, /Multiple chained statements/);
  });

  it('should block queries accessing password_hash', () => {
    const res = validateSandboxSql('SELECT email, password_hash FROM user_account;');
    assert.equal(res.allowed, false);
    assert.match(res.reason!, /password_hash/);
  });
});
