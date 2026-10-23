import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { pool, query, logSqlExecution } from '../config/db.js';
import { AuthRequest } from '../middleware/auth.js';
import { broadcastBayStatusUpdate } from '../sockets/socketHandler.js';

const bookSchema = z.object({
  vehicleId: z.string().uuid(),
  bayId: z.string().uuid(),
  tariffId: z.string().uuid(),
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  initialSoc: z.number().min(0).max(100).default(20),
  targetSoc: z.number().min(0).max(100).default(80)
});

const completeSessionSchema = z.object({
  actualEnergyKwh: z.number().positive().max(1000)
});

const notifyBayStatus = async (bayId: string, status: string) => {
  const bayRes = await pool.query(`SELECT station_id FROM charging_bay WHERE bay_id = $1`, [bayId]);
  if (bayRes.rows.length > 0) broadcastBayStatusUpdate(bayRes.rows[0].station_id, bayId, status);
};

export const bookReservation = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const driverId = req.user?.accountId;
    if (!driverId) {
      res.status(401).json({ success: false, error: 'Unauthorized driver' });
      return;
    }
    const { vehicleId, bayId, tariffId, startTime, endTime, initialSoc, targetSoc } = bookSchema.parse(req.body);

    const start = performance.now();
    const spResult = await pool.query(
      `SELECT * FROM sp_book_charging_bay_atomic($1, $2, $3, $4, $5, $6, $7, $8);`,
      [driverId, vehicleId, bayId, tariffId, startTime, endTime, initialSoc, targetSoc]
    );
    const durationMs = Number((performance.now() - start).toFixed(2));
    const result = spResult.rows[0];

    if (result.status !== 'SUCCESS') {
      logSqlExecution({
        id: Math.random().toString(36).substring(2, 9),
        sql: `INSERT INTO charging_reservation (driver_id, vehicle_id, bay_id, tariff_id, start_time, end_time, initial_soc_percent, target_soc_percent, reservation_status)\nVALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'CONFIRMED');`,
        params: [driverId, vehicleId, bayId, tariffId, startTime, endTime, initialSoc, targetSoc],
        durationMs,
        status: 'ERROR',
        error: `${result.status}: ${result.message}`,
        timestamp: new Date().toLocaleTimeString(),
        source: 'APP_MUTATION'
      });
      const statusCode = result.status === 'OVERLAP_CONFLICT' ? 409 :
                         result.status === 'INCOMPATIBLE_PORT' ? 400 :
                         result.status === 'LOCKED' ? 503 : 400;
      res.status(statusCode).json({ success: false, status: result.status, message: result.message });
      return;
    }

    logSqlExecution({
      id: Math.random().toString(36).substring(2, 9),
      sql: `INSERT INTO charging_reservation (driver_id, vehicle_id, bay_id, tariff_id, start_time, end_time, initial_soc_percent, target_soc_percent, total_amount_due, reservation_status)\nVALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'CONFIRMED')\nRETURNING reservation_id;`,
      params: [driverId, vehicleId, bayId, tariffId, startTime, endTime, initialSoc, targetSoc, result.estimated_cost],
      durationMs,
      rowCount: 1,
      status: 'SUCCESS',
      timestamp: new Date().toLocaleTimeString(),
      source: 'APP_MUTATION'
    });

    await notifyBayStatus(bayId, 'RESERVED');

    res.status(201).json({
      success: true,
      reservationId: result.reservation_id,
      status: result.status,
      message: result.message,
      estimatedCost: result.estimated_cost
    });
  } catch (error) { next(error); }
};

export const cancelReservation = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const isAdmin = req.user?.role === 'ADMIN';

    const updateSql = isAdmin
      ? `UPDATE charging_reservation
         SET reservation_status = 'CANCELLED'
         WHERE reservation_id = $1 AND reservation_status = 'CONFIRMED'
         RETURNING reservation_id, bay_id, reservation_status;`
      : `UPDATE charging_reservation
         SET reservation_status = 'CANCELLED'
         WHERE reservation_id = $1 AND driver_id = $2 AND reservation_status = 'CONFIRMED'
         RETURNING reservation_id, bay_id, reservation_status;`;

    const updateParams = isAdmin ? [id] : [id, req.user!.accountId];
    const updateRes = await query(updateSql, updateParams);

    if (updateRes.rows.length === 0) {
      res.status(400).json({ success: false, message: 'Reservation not found or cannot be cancelled' });
      return;
    }

    const bayId = updateRes.rows[0].bay_id;
    await query(`UPDATE charging_bay SET bay_status = 'AVAILABLE' WHERE bay_id = $1 AND bay_status = 'RESERVED';`, [bayId]);
    await notifyBayStatus(bayId, 'AVAILABLE');

    res.json({ success: true, message: 'Reservation cancelled successfully' });
  } catch (error) { next(error); }
};

export const completeSession = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const { actualEnergyKwh } = completeSessionSchema.parse(req.body);
    const isDriver = req.user?.role === 'DRIVER';

    const updateSql = isDriver
      ? `UPDATE charging_reservation cr
         SET reservation_status = 'COMPLETED',
             energy_delivered_kwh = $2,
             total_amount_due = ROUND($2 * tp.base_price_per_kwh * tp.peak_multiplier, 2)
         FROM tariff_plan tp
         WHERE cr.reservation_id = $1 AND cr.tariff_id = tp.tariff_id
           AND cr.driver_id = $3 AND cr.reservation_status IN ('CONFIRMED', 'ACTIVE')
         RETURNING cr.reservation_id, cr.bay_id, cr.energy_delivered_kwh, cr.total_amount_due AS final_amount, cr.reservation_status;`
      : `UPDATE charging_reservation cr
         SET reservation_status = 'COMPLETED',
             energy_delivered_kwh = $2,
             total_amount_due = ROUND($2 * tp.base_price_per_kwh * tp.peak_multiplier, 2)
         FROM tariff_plan tp
         WHERE cr.reservation_id = $1 AND cr.tariff_id = tp.tariff_id
           AND cr.reservation_status IN ('CONFIRMED', 'ACTIVE')
         RETURNING cr.reservation_id, cr.bay_id, cr.energy_delivered_kwh, cr.total_amount_due AS final_amount, cr.reservation_status;`;

    const updateParams = isDriver ? [id, actualEnergyKwh, req.user!.accountId] : [id, actualEnergyKwh];
    const updateRes = await query(updateSql, updateParams);

    if (updateRes.rows.length === 0) {
      res.status(400).json({ success: false, message: 'Reservation not found, unauthorized, or already completed' });
      return;
    }

    const result = updateRes.rows[0];
    await query(`UPDATE charging_bay SET bay_status = 'AVAILABLE' WHERE bay_id = $1 AND bay_status IN ('OCCUPIED', 'RESERVED');`, [result.bay_id]);
    await notifyBayStatus(result.bay_id, 'AVAILABLE');

    res.json({ success: true, finalAmount: result.final_amount, message: 'Charging session successfully finalized' });
  } catch (error) { next(error); }
};

export const getMyReservations = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const sql = `
      SELECT cr.reservation_id, cr.start_time, cr.end_time, cr.initial_soc_percent, cr.target_soc_percent,
             cr.energy_delivered_kwh, cr.total_amount_due, cr.reservation_status, cr.created_at,
             ev.make AS vehicle_make, ev.model AS vehicle_model, ev.license_plate, ev.connector_type,
             cb.bay_number, cs.station_name, cs.city, cs.street_address, tp.plan_name AS tariff_name
      FROM charging_reservation cr
      JOIN ev_vehicle ev ON cr.vehicle_id = ev.vehicle_id
      JOIN charging_bay cb ON cr.bay_id = cb.bay_id
      JOIN charging_station cs ON cb.station_id = cs.station_id
      JOIN tariff_plan tp ON cr.tariff_id = tp.tariff_id
      WHERE cr.driver_id = $1
      ORDER BY cr.start_time DESC;
    `;
    const result = await query(sql, [req.user!.accountId]);
    res.json({ success: true, data: result.rows });
  } catch (error) { next(error); }
};
